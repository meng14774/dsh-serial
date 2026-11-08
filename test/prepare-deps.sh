#!/usr/bin/env bash
#
# Prepare the test-only module dependencies used by test/schema.mjs and
# test/tools-live.mjs — the POSIX twin of prepare-deps.ps1 (macOS, Linux).
#
# Those two tests want the REAL `defineTool` implementation (schema compilation,
# argument validation) instead of a stub, because that is exactly the layer that
# broke during development. They also need @deepseek-ai/schemastery.
#
# This script:
#   1. copies @deepseek-ai/dsh-tools out of the DSH app.asar (read-only source)
#      into dsh-serial/node_modules;
#   2. writes the minimal stubs its imports need;
#   3. symlinks @deepseek-ai/schemastery from the desktop profile.
#
# Nothing here ships in the npm tarball (package.json "files" excludes test and
# node_modules). Delete node_modules at any time; rerun this script to restore.
#
# Usage:
#   ./test/prepare-deps.sh
#   DSH_ELECTRON="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
#   DSH_PROFILE="$HOME/.dsh/profiles/desktop" ./test/prepare-deps.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
nm="$root/node_modules/@deepseek-ai"

if [ "$(uname -s)" = "Darwin" ]; then
  default_electron="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
else
  default_electron=""
fi
electron="${DSH_ELECTRON:-$default_electron}"
profile="${DSH_PROFILE:-$HOME/.dsh/profiles/desktop}"

if [ -z "$electron" ] || [ ! -x "$electron" ]; then
  echo "DSH Electron binary not found: '${electron:-<unset>}'" >&2
  echo "Set DSH_ELECTRON to the app executable, e.g. on macOS:" >&2
  echo '  DSH_ELECTRON="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"' >&2
  exit 1
fi
if [ ! -d "$profile/node_modules/@deepseek-ai/schemastery" ]; then
  echo "schemastery not found under $profile/node_modules/@deepseek-ai (is the desktop profile installed?)" >&2
  exit 1
fi

mkdir -p "$nm"
rm -rf "$nm/dsh-tools"

# ---------------------------------------------------------------- dsh-tools
# ELECTRON_RUN_AS_NODE turns the app binary into a plain Node, which is what can
# read inside app.asar.
ELECTRON_RUN_AS_NODE=1 "$electron" "$here/extract-dsh-tools.cjs" "$nm/dsh-tools"

# The launcher can return before the child finishes writing; wait for the
# manifest instead of trusting the exit code.
deadline=$(( $(date +%s) + 30 ))
while [ ! -f "$nm/dsh-tools/package.json" ]; do
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo "asar extraction timed out: dsh-tools was not copied" >&2
    exit 1
  fi
  sleep 0.2
done

# ------------------------------------------------------------------- stubs
write_stub() { # write_stub <name> <body>
  mkdir -p "$nm/$1"
  cat > "$nm/$1/package.json" <<EOF
{"name":"@deepseek-ai/$1","version":"0.0.0-stub","type":"module","main":"index.js","exports":"./index.js"}
EOF
  cat > "$nm/$1/index.js" <<EOF
$2
EOF
}

write_stub cordis 'export class Service { constructor(ctx) { this.ctx = ctx } }
export default { Service }'

write_stub dsh-scope 'export class AnonymousEntries {}
export class NamedEntries {}
export class ScopedLayers {}
export function scopeOf() { return undefined }
export function scopeTarget() { return undefined }'

write_stub dsh-llm 'export class HarnessError extends Error { constructor(message, code) { super(message); this.code = code } }
export function createUserMessage(...args) { return { args } }'

write_stub dsh-util-values 'export function assertNever(x) { throw new Error("assertNever " + x) }
export function deepFreeze(x) { return x }
export function isJsonValue() { return true }
export function snapshotJsonValue(x) { return x }'

write_stub dsh-brand 'export function brandString(x) { return x }'

write_stub dsh-sandbox 'export const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"]
export function approveEscalation() { return true }
export function validateEscalationArgs() { return true }'

# -------------------------------------------------------------- schemastery
if [ ! -e "$nm/schemastery" ] && [ ! -L "$nm/schemastery" ]; then
  ln -s "$profile/node_modules/@deepseek-ai/schemastery" "$nm/schemastery"
fi

echo "test deps ready:"
ls -1 "$nm"