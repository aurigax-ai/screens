#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cd "$root"
pnpm pack --pack-destination "$work/pack" >/dev/null
tarball=$(ls "$work"/pack/*.tgz)

tar -tzf "$tarball" | sort > "$work/files"
unexpected=$(grep -v -E '^package/(dist/[a-z-]+\.js|CONTRACT\.md|README\.md|LICENSE|package\.json)$' "$work/files" || true)
if [ -n "$unexpected" ]; then
  echo "unexpected files in the package:" >&2
  echo "$unexpected" >&2
  exit 1
fi
for required in package/dist/cli.js package/dist/screens-init.js package/dist/screen-host.js package/CONTRACT.md package/README.md package/LICENSE; do
  grep -qx "$required" "$work/files" || { echo "missing from the package: $required" >&2; exit 1; }
done

mkdir "$work/install"
cd "$work/install"
echo '{ "name": "screens-pack-check", "private": true }' > package.json
pnpm add "$tarball" >/dev/null
pnpm exec screens --help | grep -q '^usage: screens'
version=$(pnpm exec screens --version)
expected=$(node -p "require('$root/package.json').version")
[ "$version" = "$expected" ] || { echo "screens --version printed $version, expected $expected" >&2; exit 1; }
echo "package ok: $(wc -l < "$work/files") files, screens $version"
