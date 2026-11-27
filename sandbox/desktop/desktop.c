/*
 * desktop: an agent's desktop command, the thin client of deskd (deskd.py, beside it in the image). It sends its
 * arguments to the one desktop process of this VM over a socket in the VM's own /tmp (the agent's alone; nothing
 * outside the VM can reach it), starting that process when it isn't running, and prints what it answers. A command
 * is a millisecond of its own (C0: a shell, xdpyinfo and pgrep, 15 ms, before each action).
 *
 *   desktop <verb> [arguments...]   one command (desktop help lists them); its exit code is deskd's
 *   desktop --session               JSON lines both ways, for the node's held session (SandboxHost)
 *
 * INVINCIBLE_DESKTOP_RUN is the directory of its socket (default /tmp/invincible-desktop), INVINCIBLE_DESKD the
 * process to start (default /usr/local/lib/invincible/deskd.py), INVINCIBLE_DESKTOP_WAIT how long it waits for it
 * to start (seconds, default 20). The eyes' model, the space they answer places in, their gateway and token
 * (INVINCIBLE_EYES, INVINCIBLE_EYES_SPACE, INVINCIBLE_GATEWAY, INVINCIBLE_TOKEN) go with a command from its
 * environment, never as arguments.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static const char *setting(const char *name, const char *fallback) {
  const char *v = getenv(name);
  return v && *v ? v : fallback;
}

static int connect_to(const char *path) {
  struct sockaddr_un a;
  if (strlen(path) >= sizeof a.sun_path) return -1;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  memset(&a, 0, sizeof a);
  a.sun_family = AF_UNIX;
  strcpy(a.sun_path, path);
  if (connect(fd, (struct sockaddr *)&a, sizeof a) == 0) return fd;
  close(fd);
  return -1;
}

/* deskd, started apart from this command (its own session, not its child), its output to deskd.log. */
static void start_deskd(const char *run) {
  mkdir(run, 0700);
  pid_t p = fork();
  if (p == 0) {
    setsid();
    char log[4096];
    snprintf(log, sizeof log, "%s/deskd.log", run);
    int out = open(log, O_WRONLY | O_CREAT | O_APPEND, 0600), in = open("/dev/null", O_RDONLY);
    if (in >= 0) dup2(in, 0);
    if (out >= 0) {
      dup2(out, 1);
      dup2(out, 2);
    }
    if (fork() == 0) {
      execlp("python3", "python3", "-E", "-s", setting("INVINCIBLE_DESKD", "/usr/local/lib/invincible/deskd.py"), (char *)0);
      _exit(127);
    }
    _exit(0);
  }
  if (p > 0) waitpid(p, NULL, 0);
}

static int reach(void) {
  const char *run = setting("INVINCIBLE_DESKTOP_RUN", "/tmp/invincible-desktop");
  char path[4096];
  snprintf(path, sizeof path, "%s/deskd.sock", run);
  int fd = connect_to(path);
  if (fd >= 0) return fd;
  start_deskd(run);
  double wait = atof(setting("INVINCIBLE_DESKTOP_WAIT", "20"));
  struct timespec t0, t;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  for (;;) {
    usleep(5000);
    if ((fd = connect_to(path)) >= 0) return fd;
    clock_gettime(CLOCK_MONOTONIC, &t);
    if ((t.tv_sec - t0.tv_sec) + (t.tv_nsec - t0.tv_nsec) / 1e9 > wait) return -1;
  }
}

/* A growing buffer, and a JSON string written into it (UTF-8 passes as it is). */
typedef struct { char *p; size_t n, cap; } buf;
static void put(buf *b, const char *s, size_t n) {
  if (b->n + n + 1 > b->cap) {
    b->cap = (b->n + n + 1) * 2;
    b->p = realloc(b->p, b->cap);
    if (!b->p) exit(1);
  }
  memcpy(b->p + b->n, s, n);
  b->n += n;
}
static void puts_(buf *b, const char *s) { put(b, s, strlen(s)); }
static void put_json(buf *b, const char *s) {
  put(b, "\"", 1);
  for (const unsigned char *c = (const unsigned char *)s; *c; c++) {
    if (*c == '"' || *c == '\\') {
      char e[2] = {'\\', (char)*c};
      put(b, e, 2);
    } else if (*c < 0x20) {
      char e[8];
      snprintf(e, sizeof e, "\\u%04x", *c);
      puts_(b, e);
    } else {
      put(b, (const char *)c, 1);
    }
  }
  put(b, "\"", 1);
}

static int write_all(int fd, const char *p, size_t n) {
  while (n) {
    ssize_t w = write(fd, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    p += w;
    n -= (size_t)w;
  }
  return 0;
}

static int read_all(int fd, char *p, size_t n) {
  while (n) {
    ssize_t r = read(fd, p, n);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return -1;
    p += r;
    n -= (size_t)r;
  }
  return 0;
}

/* JSON lines between stdin/stdout and deskd, until either side ends. */
static int relay(int fd) {
  if (write_all(fd, "SESSION\n", 8) < 0) return 1;
  struct pollfd ends[2] = {{0, POLLIN, 0}, {fd, POLLIN, 0}};
  char chunk[65536];
  int in_open = 1;
  for (;;) {
    if (poll(ends, 2, -1) < 0) {
      if (errno == EINTR) continue;
      return 1;
    }
    if (in_open && (ends[0].revents & (POLLIN | POLLHUP))) {
      ssize_t r = read(0, chunk, sizeof chunk);
      if (r <= 0) {
        in_open = 0;
        ends[0].fd = -1;
        shutdown(fd, SHUT_WR);
      } else if (write_all(fd, chunk, (size_t)r) < 0) return 1;
    }
    if (ends[1].revents & (POLLIN | POLLHUP)) {
      ssize_t r = read(fd, chunk, sizeof chunk);
      if (r <= 0) return 0;
      if (write_all(1, chunk, (size_t)r) < 0) return 1;
    }
  }
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc < 2 || !strcmp(argv[1], "help") || !strcmp(argv[1], "--help") || !strcmp(argv[1], "-h")) {
    execlp("python3", "python3", "-E", "-s", setting("INVINCIBLE_DESKD", "/usr/local/lib/invincible/deskd.py"), "help", (char *)0);
    perror("desktop: python3");
    return 127;
  }
  int session = !strcmp(argv[1], "--session");
  for (int attempt = 0; attempt < 2; attempt++) {
    int fd = reach();
    if (fd < 0) {
      fprintf(stderr, "desktop: the desktop process did not start (see %s/deskd.log)\n", setting("INVINCIBLE_DESKTOP_RUN", "/tmp/invincible-desktop"));
      return 1;
    }
    if (session) return relay(fd);
    buf b = {0};
    puts_(&b, "ARGV\n{\"argv\":[");
    for (int i = 1; i < argc; i++) {
      if (i > 1) puts_(&b, ",");
      put_json(&b, argv[i]);
    }
    char cwd[4096];
    puts_(&b, "],\"cwd\":");
    put_json(&b, getcwd(cwd, sizeof cwd) ? cwd : "/work");
    puts_(&b, ",\"env\":{");
    const char *keys[] = {"INVINCIBLE_EYES", "INVINCIBLE_EYES_SPACE", "INVINCIBLE_GATEWAY", "INVINCIBLE_TOKEN"};
    int any = 0;
    for (size_t i = 0; i < sizeof keys / sizeof *keys; i++) {
      const char *v = getenv(keys[i]);
      if (!v) continue;
      if (any++) puts_(&b, ",");
      put_json(&b, keys[i]);
      puts_(&b, ":");
      put_json(&b, v);
    }
    puts_(&b, "}}\n");
    if (write_all(fd, b.p, b.n) < 0) {
      close(fd);
      free(b.p);
      continue;
    }
    free(b.p);
    /* "exit=<code> out=<bytes> err=<bytes>\n", then what it prints and what it says. */
    char head[128];
    size_t n = 0;
    while (n < sizeof head - 1 && read(fd, head + n, 1) == 1 && head[n] != '\n') n++;
    head[n] = 0;
    int code;
    size_t out, err;
    if (sscanf(head, "exit=%d out=%zu err=%zu", &code, &out, &err) != 3) {
      close(fd);
      continue; /* it ended as it answered (a desktop stopped under it): once more, with one started again */
    }
    char *text = malloc(out + err + 1);
    if (!text || read_all(fd, text, out + err) < 0) {
      fprintf(stderr, "desktop: the desktop process ended before it answered\n");
      return 1;
    }
    write_all(1, text, out);
    write_all(2, text + out, err);
    return code;
  }
  fprintf(stderr, "desktop: the desktop process ended before it answered (see %s/deskd.log)\n", setting("INVINCIBLE_DESKTOP_RUN", "/tmp/invincible-desktop"));
  return 1;
}
