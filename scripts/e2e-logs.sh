#!/usr/bin/env bash
set -euo pipefail

BUILD_LOG=".adapter-build.log"
SERVER_LOG=".adapter-server.log"
DEPLOYMENT_FILE=".brrrd-harness/deployment.json"

persist_diagnostics() {
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
  local dest="$GITHUB_WORKSPACE/harness-diagnostics/live/$digest"
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

  if [[ "${BRRRD_HARNESS_COPY_PACKAGE:-0}" == "1" && -d "dist/brrrd" ]]; then
    rm -rf "$dest/dist/brrrd-package"
    mkdir -p "$dest/dist"
    cp -R "dist/brrrd" "$dest/dist/brrrd-package"
  fi
}

marker_value() {
  local name="$1"
  local fallback="$2"
  if [[ -f "$BUILD_LOG" ]]; then
    local line
    line="$(grep "^$name:" "$BUILD_LOG" | tail -n1 || true)"
    if [[ -n "$line" ]]; then
      printf '%s\n' "${line#*: }"
      return 0
    fi
  fi
  printf '%s\n' "$fallback"
}

build_id_fallback="undefined"
if [[ -f .next/BUILD_ID ]]; then
  build_id_fallback="$(cat .next/BUILD_ID)"
fi

persist_diagnostics

printf 'BUILD_ID: %s\n' "$(marker_value BUILD_ID "$build_id_fallback")"
printf 'DEPLOYMENT_ID: %s\n' "$(marker_value DEPLOYMENT_ID undefined)"
printf 'IMMUTABLE_ASSET_TOKEN: %s\n' "$(marker_value IMMUTABLE_ASSET_TOKEN undefined)"

printf '\n=== brrrd harness environment ===\n'
printf 'NEXT_TEST_DIR=%s\n' "${NEXT_TEST_DIR:-}"
printf 'NEXT_TEST_DEPLOY_URL=%s\n' "${NEXT_TEST_DEPLOY_URL:-}"

if [[ -f "$DEPLOYMENT_FILE" ]]; then
  printf '\n=== %s ===\n' "$DEPLOYMENT_FILE"
  cat "$DEPLOYMENT_FILE"
fi

if [[ -f "$BUILD_LOG" ]]; then
  printf '\n=== %s ===\n' "$BUILD_LOG"
  cat "$BUILD_LOG"
fi

if [[ -f "$SERVER_LOG" ]]; then
  printf '\n=== %s ===\n' "$SERVER_LOG"
  cat "$SERVER_LOG"
fi
