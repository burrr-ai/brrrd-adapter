#!/usr/bin/env bash
set -euo pipefail

BUILD_LOG=".adapter-build.log"
SERVER_LOG=".adapter-server.log"
DEPLOYMENT_FILE=".brrrd-harness/deployment.json"

log() {
  printf '[brrrd-harness] %s\n' "$*" >&2
}

persist_final_diagnostics() {
  if [[ -z "${GITHUB_WORKSPACE:-}" ]]; then
    return 0
  fi

  local digest
  digest="$(
    node --input-type=module -e '
      import crypto from "node:crypto";
      console.log(crypto.createHash("sha1").update(process.cwd()).digest("hex"));
    '
  )"
  local dest="$GITHUB_WORKSPACE/harness-diagnostics/final/$digest"
  mkdir -p "$dest"
  printf '%s\n' "$PWD" > "$dest/source.txt"

  local files=(
    "$BUILD_LOG"
    "$SERVER_LOG"
    "$DEPLOYMENT_FILE"
    ".next/routes-manifest.json"
    ".next/prerender-manifest.json"
    ".next/build-manifest.json"
    ".next/app-build-manifest.json"
    ".next/server/app-paths-manifest.json"
    ".next/server/pages-manifest.json"
    ".next/server/middleware-manifest.json"
    "dist/brrrd/manifest.json"
    "dist/brrrd/adapter-context.json"
  )

  for file in "${files[@]}"; do
    if [[ -f "$file" ]]; then
      local safe_file="$file"
      safe_file="${safe_file#.}"
      safe_file="${safe_file//\/./\/}"
      mkdir -p "$dest/$(dirname "$safe_file")"
      cp "$file" "$dest/$safe_file"
    fi
  done
}

trap 'persist_final_diagnostics || true' EXIT

if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
  log "no deployment metadata found; nothing to clean up"
  exit 0
fi

PID="$(
  node --input-type=module -e '
    import fs from "node:fs";
    try {
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (Number.isInteger(data.pid) && data.pid > 0) console.log(data.pid);
    } catch {}
  ' "$DEPLOYMENT_FILE"
)"

if [[ -z "$PID" ]]; then
  log "deployment metadata has no pid; nothing to clean up"
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  log "process $PID is already gone"
  exit 0
fi

log "stopping brrrd process $PID"
kill "$PID" 2>/dev/null || true

for _ in $(seq 1 50); do
  if ! kill -0 "$PID" 2>/dev/null; then
    exit 0
  fi
  sleep 0.1
done

log "process $PID did not exit after SIGTERM; sending SIGKILL"
kill -9 "$PID" 2>/dev/null || true
