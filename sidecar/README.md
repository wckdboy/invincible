# Rent sidecar

Each preset image layers these scripts on a real workload base. The image
`ENTRYPOINT` is `bootstrap.sh`. RunPod REST API v2 `ContainerConfig.entrypoint`
overrides the image entrypoint (`https://api.runpod.io/v2/openapi.json`,
fetched 2026-10-29), so the node does not send that field. The preset command
is `INVINCIBLE_WORKLOAD`.

| Preset | Image | Base (digest pinned in the Dockerfile) | Workload |
|---|---|---|---|
| `vllm` | `ghcr.io/wckdboy/invincible-rent-vllm:edge` | `vllm/vllm-openai:v0.32.0` | `vllm serve --host 0.0.0.0 --port 8000` |
| `comfyui-minimax-h3` | `ghcr.io/wckdboy/invincible-rent-comfyui:edge` | `runpod/comfyui:1.2.1` | `/start.sh` |
| `dev-box` | `ghcr.io/wckdboy/invincible-rent-dev-box:edge` | `runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404` | `/start.sh` |

`bootstrap.sh` hydrates the project prefix, writes `hydrate-ok.json`, and starts
the workload without the R2, AWS, or `RCLONE_CONFIG*` environment. If that
process exits, or the deadline in `INVINCIBLE_DEADLINE_AT` passes, or
`control.json` says `drain`, it drains and the container exits. It does not
keep a paid GPU idle after the workload has gone. A preset with no workload
(an empty command) holds until the deadline.

`drain.sh` syncs the workspace back and writes `drain-ok.json`. A missing
source, or an empty source whose remote prefix is not empty, fails and does
not write the marker, so a crash cannot wipe the project. The default source
is `$INVINCIBLE_WORKSPACE` (`/workspace` when that is unset).

## Private packages

GitHub Container Registry creates a package as private. RunPod cannot pull a
private package. This repo does not change that visibility.

Either make each package public (the package's GitHub settings, after the
first push from `main`), or add the registry in the RunPod console and set
the credential id:

```toml
[rent]
container_registry_auth_id = "reg_..."
```

That value is the id RunPod's create-pod body calls `registry` (`ContainerConfig.registry`,
"Container registry credential ID (for private images)"). It is not logged.

```bash
docker build -f sidecar/vllm.Dockerfile -t ghcr.io/wckdboy/invincible-rent-vllm:edge sidecar
```

`.github/workflows/rent-sidecar.yml` builds the three images. It pushes
`:edge` from `main`. It does not publish a release.
