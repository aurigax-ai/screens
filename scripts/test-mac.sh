#!/usr/bin/env bash
set -euo pipefail

host=${SCREENS_MAC_HOST:?set SCREENS_MAC_HOST to the ssh target of the Mac test host}
root=$(cd "$(dirname "$0")/.." && pwd)
image=${SCREENS_OCI_IMAGE:-localhost/screens-desktop:dev}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

missing=$(ssh -o BatchMode=yes "$host" 'export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH; for program in docker node pnpm; do command -v $program >/dev/null || printf "%s " $program; done; docker version >/dev/null 2>&1 || printf "docker-daemon"')
if [ -n "$missing" ]; then
  echo "the Mac test host lacks: $missing" >&2
  exit 1
fi

cd "$root"
pnpm pack --pack-destination "$work" >/dev/null
podman save "$image" -o "$work/image.tar"
remote=$(ssh "$host" 'mktemp -d /tmp/screens-mac-XXXXXX')
scp -q "$work"/*.tgz "$work/image.tar" test/mac/remote.mjs "$host:$remote/"
ssh "$host" "export PATH=/usr/local/bin:/opt/homebrew/bin:\$PATH; cd $remote \
  && docker load -q -i image.tar >/dev/null \
  && echo '{ \"name\": \"screens-mac-test\", \"private\": true }' > package.json \
  && pnpm add ./*.tgz >/dev/null \
  && XDG_RUNTIME_DIR=$remote/run XDG_STATE_HOME=$remote/state SCREENS_OCI_IMAGE=$image node remote.mjs; \
  docker rmi $image >/dev/null 2>&1; rm -rf $remote"
