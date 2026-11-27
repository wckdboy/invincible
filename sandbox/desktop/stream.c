/*
 * desktop-stream: the desktop's screen as H.264 while someone watches it (C1 step 9). The node runs it in the VM by a
 * held exec of its own, reads its frames on stdout, and stops it by closing its pipes: it lives exactly as long as its
 * reader, and encodes nothing when no one watches.
 *
 * The screen is captured (MIT-SHM) only when it changed: DAMAGE says the picture did, or the pointer moved or changed
 * shape. At most 10 frames a second, 25 for 2 s after a `fast` (your own input, as you take over). Nothing while it is
 * still. Each frame is the whole screen with the pointer drawn in, as deskd's pictures are, encoded by OpenH264
 * (BSD-2-Clause; H.264's patents: docs/ARCHITECTURE.md) as Constrained Baseline, in its camera mode (its settings and
 * why: below). Its first frame is a keyframe, and so is the one after a `key` (a new watcher).
 *
 * Its frames, on stdout: a 4-byte big-endian length of what follows it, a byte for the kind (1 a keyframe, with its SPS
 * and PPS; 2 any other), an 8-byte big-endian capture time (milliseconds since the epoch), then the frame's NAL units,
 * Annex B. Commands on stdin, a line each: `key`, `fast`. Exit 0 when stdin or stdout is closed, 2 when the display or
 * the encoder can't be had.
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <time.h>
#include <unistd.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xdamage.h>
#include <X11/extensions/Xfixes.h>
#include <wels/codec_api.h>

enum { KIND_KEY = 1, KIND_DELTA = 2, HEADER = 13, SLOW_MS = 100, FAST_MS = 40, FAST_FOR_MS = 2000, STILL_POLL_MS = 100, REFINE = 5 };
static const int BITRATE = 1500000, MAX_BITRATE = 3000000;

static uint64_t wall_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_REALTIME, &t);
  return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}

static uint64_t mono_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}

static int fail(const char *what) {
  fprintf(stderr, "desktop-stream: %s\n", what);
  return 2;
}

/* All of it to stdout, or false when its reader has gone. */
static bool put(const uint8_t *p, size_t n) {
  while (n) {
    ssize_t w = write(1, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    p += w;
    n -= (size_t)w;
  }
  return true;
}

/*
 * The screen's BGRX to I420, BT.601 limited range (what a decoder assumes when a stream says nothing of its colour).
 * Written as plain loops over rows, so the compiler vectorizes them (-O3).
 */
static void to_i420(const uint8_t *restrict src, int stride, int w, int h, uint8_t *restrict y, uint8_t *restrict u, uint8_t *restrict v) {
  for (int row = 0; row < h; row++) {
    const uint8_t *s = src + (size_t)row * (size_t)stride;
    uint8_t *yy = y + (size_t)row * (size_t)w;
    for (int col = 0; col < w; col++) {
      int bl = s[4 * col], g = s[4 * col + 1], r = s[4 * col + 2];
      yy[col] = (uint8_t)(((66 * r + 129 * g + 25 * bl + 128) >> 8) + 16);
    }
  }
  int half = w / 2;
  for (int row = 0; row < h; row += 2) {
    const uint8_t *a = src + (size_t)row * (size_t)stride, *b = a + stride;
    uint8_t *uu = u + (size_t)(row / 2) * (size_t)half, *vv = v + (size_t)(row / 2) * (size_t)half;
    for (int col = 0; col < half; col++) {
      const uint8_t *p = a + 8 * col, *q = b + 8 * col;
      int bl = (p[0] + p[4] + q[0] + q[4] + 2) >> 2, g = (p[1] + p[5] + q[1] + q[5] + 2) >> 2, r = (p[2] + p[6] + q[2] + q[6] + 2) >> 2;
      uu[col] = (uint8_t)(((-38 * r - 74 * g + 112 * bl + 128) >> 8) + 128);
      vv[col] = (uint8_t)(((112 * r - 94 * g - 18 * bl + 128) >> 8) + 128);
    }
  }
}

/* The pointer, drawn in where it is (its image is premultiplied ARGB). Says where that was. */
static void draw_pointer(Display *d, uint8_t *bgrx, int stride, int w, int h, int *at_x, int *at_y) {
  XFixesCursorImage *c = XFixesGetCursorImage(d);
  if (!c) return;
  *at_x = c->x;
  *at_y = c->y;
  int x0 = c->x - c->xhot, y0 = c->y - c->yhot;
  for (int j = 0; j < c->height; j++) {
    int y = y0 + j;
    if (y < 0 || y >= h) continue;
    for (int i = 0; i < c->width; i++) {
      int x = x0 + i;
      if (x < 0 || x >= w) continue;
      unsigned long p = c->pixels[(size_t)j * c->width + (size_t)i];
      unsigned alpha = (unsigned)((p >> 24) & 0xff);
      if (!alpha) continue;
      uint8_t *px = bgrx + (size_t)y * (size_t)stride + (size_t)x * 4;
      px[0] = (uint8_t)((p & 0xff) + px[0] * (255 - alpha) / 255);
      px[1] = (uint8_t)(((p >> 8) & 0xff) + px[1] * (255 - alpha) / 255);
      px[2] = (uint8_t)(((p >> 16) & 0xff) + px[2] * (255 - alpha) / 255);
    }
  }
  XFree(c);
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  // (The desktop's own display, deskd's :1, unless DISPLAY names another: an exec into the VM has none set.)
  Display *d = XOpenDisplay(getenv("DISPLAY") ? NULL : ":1");
  if (!d) return fail("no display (is the desktop started? desktop start)");
  int screen = DefaultScreen(d), w = DisplayWidth(d, screen) & ~1, h = DisplayHeight(d, screen) & ~1;
  Window root = RootWindow(d, screen);
  int damage_base, damage_error, fixes_base, fixes_error;
  if (!XShmQueryExtension(d)) return fail("the display has no MIT-SHM");
  if (!XDamageQueryExtension(d, &damage_base, &damage_error)) return fail("the display has no DAMAGE");
  if (!XFixesQueryExtension(d, &fixes_base, &fixes_error)) return fail("the display has no XFIXES");

  XShmSegmentInfo shm;
  XImage *img = XShmCreateImage(d, DefaultVisual(d, screen), (unsigned)DefaultDepth(d, screen), ZPixmap, NULL, &shm, (unsigned)w, (unsigned)h);
  if (!img || img->bits_per_pixel != 32) return fail("the screen isn't 32 bits a pixel");
  shm.shmid = shmget(IPC_PRIVATE, (size_t)img->bytes_per_line * (size_t)img->height, IPC_CREAT | 0600);
  if (shm.shmid < 0) return fail("no shared memory for the screen");
  shm.shmaddr = img->data = shmat(shm.shmid, NULL, 0);
  shm.readOnly = False;
  if (shm.shmaddr == (char *)-1 || !XShmAttach(d, &shm)) return fail("the screen's shared memory can't be attached");
  XSync(d, False);
  shmctl(shm.shmid, IPC_RMID, NULL);
  Damage damage = XDamageCreate(d, root, XDamageReportNonEmpty);
  XFixesSelectCursorInput(d, root, XFixesDisplayCursorNotifyMask);

  ISVCEncoder *enc = NULL;
  if (WelsCreateSVCEncoder(&enc) || !enc) return fail("OpenH264 has no encoder");
  // Its settings, as measured in a 1-vCPU VM against the bars (C1 step 9.1, BENCHMARKS.md):
  // - camera mode encodes a frame in a third of screen-content mode's time (2.5 ms scrolling text, 5.5 ms an animation,
  //   against 7 and 17);
  // - without the deblocking filter, 0.7 points less of a core on the animation;
  // - the rate by quality: by bitrate, a burst of motion is paid back by starving the frames after it, and a screen that
  //   has stopped kept motion's ghosts; by quality, it is clean after its REFINE frames more, for the same bytes;
  // - no frame is ever skipped.
  SEncParamExt p;
  (*enc)->GetDefaultParams(enc, &p);
  p.iUsageType = CAMERA_VIDEO_REAL_TIME;
  p.iPicWidth = w;
  p.iPicHeight = h;
  p.iRCMode = RC_QUALITY_MODE;
  p.iTargetBitrate = BITRATE;
  p.iMaxBitrate = MAX_BITRATE;
  p.fMaxFrameRate = 15.0f;
  p.bEnableFrameSkip = false;
  p.uiIntraPeriod = 0;
  p.iTemporalLayerNum = 1;
  p.iSpatialLayerNum = 1;
  p.iMultipleThreadIdc = 1;
  p.iComplexityMode = LOW_COMPLEXITY;
  p.eSpsPpsIdStrategy = CONSTANT_ID;
  p.iEntropyCodingModeFlag = 0;
  p.iLoopFilterDisableIdc = 1;
  p.bEnableDenoise = false;
  p.bEnableBackgroundDetection = true;
  p.bEnableAdaptiveQuant = false;
  p.bEnableSceneChangeDetect = true;
  SSpatialLayerConfig *layer = &p.sSpatialLayers[0];
  layer->iVideoWidth = w;
  layer->iVideoHeight = h;
  layer->fFrameRate = p.fMaxFrameRate;
  layer->iSpatialBitrate = BITRATE;
  layer->iMaxSpatialBitrate = MAX_BITRATE;
  layer->uiProfileIdc = PRO_BASELINE;
  layer->sSliceArgument.uiSliceMode = SM_SINGLE_SLICE;
  int format = videoFormatI420, quiet = WELS_LOG_ERROR;
  (*enc)->SetOption(enc, ENCODER_OPTION_TRACE_LEVEL, &quiet);
  if ((*enc)->InitializeExt(enc, &p) != cmResultSuccess) return fail("OpenH264 refused its settings");
  (*enc)->SetOption(enc, ENCODER_OPTION_DATAFORMAT, &format);

  size_t luma = (size_t)w * (size_t)h;
  uint8_t *yuv = malloc(luma * 3 / 2), *out = NULL;
  size_t room = 0;
  if (!yuv) return fail("no memory for a frame");
  SSourcePicture pic;
  memset(&pic, 0, sizeof pic);
  pic.iColorFormat = videoFormatI420;
  pic.iPicWidth = w;
  pic.iPicHeight = h;
  pic.iStride[0] = w;
  pic.iStride[1] = pic.iStride[2] = w / 2;
  pic.pData[0] = yuv;
  pic.pData[1] = yuv + luma;
  pic.pData[2] = yuv + luma + luma / 4;

  fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);
  char said[256];
  size_t heard = 0;
  bool dirty = true, key = true;
  int refine = 0;
  uint64_t last = 0, fast_until = 0;
  int pointer_x = -1, pointer_y = -1, code = 0;
  for (;;) {
    uint64_t t = mono_ms();
    uint64_t interval = t < fast_until ? FAST_MS : SLOW_MS;
    int timeout = STILL_POLL_MS;
    if (dirty) timeout = last + interval > t ? (int)(last + interval - t) : 0;
    if (!XPending(d)) {
      struct pollfd fds[2] = {{ConnectionNumber(d), POLLIN, 0}, {0, POLLIN, 0}};
      poll(fds, 2, timeout);
      if (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) {
        ssize_t n = read(0, said + heard, sizeof said - 1 - heard);
        if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) break;
        if (n > 0) {
          heard += (size_t)n;
          said[heard] = 0;
          char *line = said, *nl;
          while ((nl = strchr(line, '\n'))) {
            *nl = 0;
            if (!strcmp(line, "key")) key = dirty = true;
            else if (!strcmp(line, "fast")) fast_until = mono_ms() + FAST_FOR_MS;
            line = nl + 1;
          }
          heard = strlen(line);
          memmove(said, line, heard);
          if (heard == sizeof said - 1) heard = 0;
        }
      }
    }
    while (XPending(d)) {
      XEvent e;
      XNextEvent(d, &e);
      if (e.type == damage_base + XDamageNotify) {
        XDamageSubtract(d, damage, None, None);
        dirty = true;
      } else if (e.type == fixes_base + XFixesCursorNotify) {
        dirty = true;
      }
    }
    Window r, child;
    int rx, ry, wx, wy;
    unsigned mask;
    if (XQueryPointer(d, root, &r, &child, &rx, &ry, &wx, &wy, &mask) && (rx != pointer_x || ry != pointer_y)) dirty = true;
    t = mono_ms();
    interval = t < fast_until ? FAST_MS : SLOW_MS;
    // (Once it is still, a few frames more of the same screen: the encoder refines away what motion left behind.)
    bool refining = !dirty && refine > 0;
    if ((!dirty && !refining) || t < last + interval) continue;

    uint64_t taken = wall_ms();
    if (!XShmGetImage(d, root, img, 0, 0, AllPlanes)) {
      code = fail("the screen can't be read");
      break;
    }
    draw_pointer(d, (uint8_t *)img->data, img->bytes_per_line, w, h, &pointer_x, &pointer_y);
    to_i420((const uint8_t *)img->data, img->bytes_per_line, w, h, pic.pData[0], pic.pData[1], pic.pData[2]);
    pic.uiTimeStamp = (long long)t;
    if (key) (*enc)->ForceIntraFrame(enc, true);
    SFrameBSInfo info;
    memset(&info, 0, sizeof info);
    if ((*enc)->EncodeFrame(enc, &pic, &info) != cmResultSuccess) {
      code = fail("OpenH264 couldn't encode a frame");
      break;
    }
    // (On a fixed grid while it keeps moving, so the time each frame takes never slows the rate below its 10 a second.)
    last = t - last < 2 * interval ? last + interval : t;
    refine = refining ? refine - 1 : REFINE;
    dirty = false;
    if (info.eFrameType == videoFrameTypeSkip || info.eFrameType == videoFrameTypeInvalid) continue;
    key = false;
    size_t size = 0;
    for (int l = 0; l < info.iLayerNum; l++)
      for (int n = 0; n < info.sLayerInfo[l].iNalCount; n++) size += (size_t)info.sLayerInfo[l].pNalLengthInByte[n];
    if (HEADER + size > room) {
      room = (HEADER + size) * 2;
      uint8_t *bigger = realloc(out, room);
      if (!bigger) {
        code = fail("no memory for a frame's bytes");
        break;
      }
      out = bigger;
    }
    uint32_t length = (uint32_t)(9 + size);
    out[0] = (uint8_t)(length >> 24), out[1] = (uint8_t)(length >> 16), out[2] = (uint8_t)(length >> 8), out[3] = (uint8_t)length;
    out[4] = info.eFrameType == videoFrameTypeIDR ? KIND_KEY : KIND_DELTA;
    for (int i = 0; i < 8; i++) out[5 + i] = (uint8_t)(taken >> (56 - 8 * i));
    size_t at = HEADER;
    for (int l = 0; l < info.iLayerNum; l++) {
      size_t part = 0;
      for (int n = 0; n < info.sLayerInfo[l].iNalCount; n++) part += (size_t)info.sLayerInfo[l].pNalLengthInByte[n];
      memcpy(out + at, info.sLayerInfo[l].pBsBuf, part);
      at += part;
    }
    if (!put(out, at)) break;
  }
  (*enc)->Uninitialize(enc);
  WelsDestroySVCEncoder(enc);
  XShmDetach(d, &shm);
  shmdt(shm.shmaddr);
  XCloseDisplay(d);
  free(yuv);
  free(out);
  return code;
}
