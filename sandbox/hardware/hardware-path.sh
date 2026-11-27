# Read by every login shell in the hardware image (/etc/profile.d). An agent's commands run in login shells, where
# Debian's /etc/profile sets PATH afresh (the workshop's tools-path.sh says why): this puts kipy's venv first there,
# so their python3 imports kipy, and pcbnew's own module from Debian's packages, which the venv sees. Unless it is
# there already (a login shell started from another). deskd and the apps it starts aren't login shells: they keep
# Debian's own python3. packages/sandbox/test/hardware.test.ts holds this and the Dockerfile together.
case ":$PATH:" in
  *":/opt/hardware/bin:"*) ;;
  *) PATH="/opt/hardware/bin:$PATH" ;;
esac
export PATH
