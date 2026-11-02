#!/bin/sh
# Run administrative CLI commands inside the locally built Server image.
# Linux only: host networking preserves the loopback-only plaintext boundary.
set -eu
: "${DOCK_IMAGE:?Set DOCK_IMAGE to the fixed Server image tag or digest}"
if [ "$(uname -s)" != Linux ]; then
  echo 'Server Docker deployment requires Linux.' >&2
  exit 1
fi
if [ "$#" -eq 0 ]; then
  echo 'Usage: server-docker.sh <init|deploy|invite|pair|doctor> ...' >&2
  exit 1
fi
case "$1" in
  init|deploy|invite|pair|doctor) ;;
  *) echo 'Use Docker Compose to run the persistent Server.' >&2; exit 1 ;;
esac
# Preserve absolute paths in generated Compose/.env files and the host owner UID/GID.
# Only this deployment directory is mounted; keep all CLI file arguments inside it.
deployment_root=$(pwd -P)
exec docker run --rm --init --network host \
  --user "$(id -u):$(id -g)" --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount "type=bind,src=$deployment_root,dst=$deployment_root" \
  --workdir "$deployment_root" "$DOCK_IMAGE" "$@"
