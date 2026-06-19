#!/usr/bin/env bash
set -euo pipefail

DEPLOYMENT_FILE=".brrrd-harness/deployment.json"

log() {
  printf '[brrrd-harness] %s\n' "$*" >&2
}

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
