#!/usr/bin/env bash
#
# Build the installable dsh-serial tarball into ../dist — the POSIX twin of
# build.ps1 (macOS, Linux). Run it with bash, not sh.
#
#   ./build.sh 0.1.7          # bump package.json, pack, print sha256
#   ./build.sh                # pack the current version
#   ./build.sh 0.1.7 --force  # pack even if the tarball already exists
#
# A version bump is not cosmetic: pnpm/npm treat an unchanged version as
# "nothing to do", and the DSH profile installs a *file* dependency.
#
# Requires: node (the DSH app ships one; `brew install node` is fine) and npm.
# Nothing here is platform-specific.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/package.json"
dist="$(dirname "$here")/dist"
version="${1:-}"
force="${2:-}"

if [ -n "$version" ]; then
  node -e '
    const fs = require("node:fs")
    const file = process.argv[1]
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
    pkg.version = process.argv[2]
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n", "utf8")
  ' "$pkg" "$version"
  echo "version -> $version"
fi

current="$(node -e 'console.log(require(process.argv[1]).version)' "$pkg")"
# The tarball name is decided by npm, not by us: a scoped package (@scope/name)
# packs as "scope-name-<ver>.tgz". Ask npm for the real filename instead of
# guessing it, or the checksum step below points at a file that does not exist.
name="$(node -e 'console.log(require(process.argv[1]).name)' "$pkg")"
flat="${name#@}"; flat="${flat//\//-}"
tarball="$dist/${flat}-${current}.tgz"

if [ -e "$tarball" ] && [ "$force" != "--force" ]; then
  echo "tarball already exists: $tarball (bump the version or pass --force)" >&2
  exit 1
fi

mkdir -p "$dist"
(cd "$here" && npm pack --pack-destination "$dist" >/dev/null)

echo
echo "built: $tarball"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$tarball"
else
  sha256sum "$tarball"
fi
echo
echo "Next steps:"
echo "  1) install:  plugin_manager install_bundle target=$tarball"
echo "  2) restart DSH (running hosts snapshot their resolvable packages at boot)"
echo "  3) verify:   serial_list / serial_status, and http://127.0.0.1:19387/dsh-serial"