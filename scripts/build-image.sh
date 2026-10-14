#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
runtime=${SCREENS_IMAGE_RUNTIME:-podman}
image=${SCREENS_OCI_IMAGE:-localhost/screens-desktop:dev}

cd "$root"
pnpm run build >/dev/null
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
cp -r Containerfile package.json dist "$context/"
"$runtime" build --label screens.build=local -t "$image" -f "$context/Containerfile" "$context"
