# Rent sidecar

The node does not copy project files itself. The pod runs these scripts.

`bootstrap.sh` reads `INVINCIBLE_*` (the names the node puts on the pod, including
`INVINCIBLE_DEADLINE_AT` and `INVINCIBLE_WORKLOAD`), hydrates the project prefix,
writes `hydrate-ok.json`, starts the workload, and drains when the deadline
passes or `control.json` says `drain`. `drain.sh` syncs the workspace back and
writes `drain-ok.json`.

RunPod's create-pod `entrypoint` field replaces the image entrypoint. This image
sets `ENTRYPOINT` to the bootstrap, and the node does not send `entrypoint`, so
the preset command is only `INVINCIBLE_WORKLOAD`.

```bash
docker build -t ghcr.io/wckdboy/invincible-rent-sidecar:edge sidecar
```

The workflow `.github/workflows/rent-sidecar.yml` builds that image. It pushes
to GHCR from `main`. It does not publish a release.
