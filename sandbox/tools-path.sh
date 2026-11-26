# Read by every login shell in the knights' image (/etc/profile.d). Debian's /etc/profile sets PATH afresh,
# which takes the image's own tools off it, and a knight's commands run in login shells: without this a gate
# of `bun test` exits 127 in a knight's VM. Each directory the Dockerfile puts on the PATH is put back here,
# in the Dockerfile's order, unless it is there already (a login shell started from another).
# packages/sandbox/test/image-path.test.ts holds this and the Dockerfile together.
for dir in /opt/bun/bin /opt/node/bin /opt/opencode/bin /opt/engram/bin; do
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) PATH="$dir:$PATH" ;;
  esac
done
unset dir
# What was installed in this VM for itself (a vendor's coding tool, as its vendor documents), kept with the
# workspace. Last: nothing put there can stand in for a tool the image or the system has.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) PATH="$PATH:$HOME/.local/bin" ;;
esac
export PATH
