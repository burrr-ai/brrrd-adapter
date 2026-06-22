#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(pwd)"
HARNESS_DIR="$APP_DIR/.brrrd-harness"
BUILD_LOG="$APP_DIR/.adapter-build.log"
SERVER_LOG="$APP_DIR/.adapter-server.log"
DEPLOYMENT_FILE="$HARNESS_DIR/deployment.json"
PID=""

log() {
  printf '[brrrd-harness] %s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

persist_diagnostics() {
  if [[ -z "${GITHUB_WORKSPACE:-}" ]]; then
    return 0
  fi

  local digest
  digest="$(
    node --input-type=module -e '
      import crypto from "node:crypto";
      console.log(crypto.createHash("sha1").update(process.cwd()).digest("hex"));
    ' 2>/dev/null || printf unknown
  )"
  local dest="$GITHUB_WORKSPACE/harness-diagnostics/deploy-failed/$digest"
  mkdir -p "$dest"
  printf '%s\n' "$PWD" > "$dest/source.txt"

  for file in "$BUILD_LOG" "$SERVER_LOG" "$DEPLOYMENT_FILE"; do
    if [[ -f "$file" ]]; then
      local safe_file="$file"
      safe_file="${safe_file#.}"
      safe_file="${safe_file//\/./\/}"
      mkdir -p "$dest/$(dirname "$safe_file")"
      cp "$file" "$dest/$safe_file"
    fi
  done
}

cleanup_on_error() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    persist_diagnostics || true
    if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null || true
    fi
  fi
}

trap cleanup_on_error EXIT

run_logged() {
  local label="$1"
  shift
  log "$label"
  {
    printf '\n## %s\n' "$label"
    printf '$'
    printf ' %q' "$@"
    printf '\n'
  } >>"$BUILD_LOG"
  "$@" >>"$BUILD_LOG" 2>&1 || {
    local status=$?
    log "$label failed with exit status $status"
    tail -200 "$BUILD_LOG" >&2 || true
    return "$status"
  }
}

detect_package_manager() {
  local declared
  declared="$(
    node --input-type=module -e '
      import fs from "node:fs";
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      console.log((pkg.packageManager || "").split("@")[0]);
    ' 2>/dev/null || true
  )"
  case "$declared" in
    pnpm|npm|yarn) printf '%s\n' "$declared"; return 0 ;;
  esac
  if [[ -f pnpm-lock.yaml ]] || command -v pnpm >/dev/null 2>&1; then
    printf 'pnpm\n'
  elif [[ -f yarn.lock ]] || command -v yarn >/dev/null 2>&1; then
    printf 'yarn\n'
  else
    printf 'npm\n'
  fi
}

pm_install() {
  ensure_python_command
  if [[ "$PM" == "pnpm" ]]; then
    ensure_pnpm_build_policy
  fi
  case "$PM" in
    pnpm) run_logged "install app dependencies" pnpm install --no-frozen-lockfile ;;
    npm) run_logged "install app dependencies" npm install ;;
    yarn) run_logged "install app dependencies" yarn install --no-immutable ;;
    *) die "unsupported package manager: $PM" ;;
  esac
}

ensure_python_command() {
  if command -v python >/dev/null 2>&1; then
    return 0
  fi
  local python3_bin
  python3_bin="$(command -v python3 2>/dev/null || true)"
  if [[ -z "$python3_bin" ]]; then
    return 0
  fi

  mkdir -p "$HARNESS_DIR/bin"
  cat >"$HARNESS_DIR/bin/python" <<EOF
#!/usr/bin/env bash
exec "$python3_bin" "\$@"
EOF
  chmod +x "$HARNESS_DIR/bin/python"
  export PATH="$HARNESS_DIR/bin:$PATH"
}

ensure_pnpm_build_policy() {
  node "$ADAPTER_DIR/scripts/pnpm-build-policy.mjs"
  if node "$ADAPTER_DIR/scripts/pnpm-build-policy.mjs" --has-only-built-dependencies; then
    return 0
  fi
  if [[ "${BRRRD_HARNESS_PNPM_ALLOW_ALL_BUILDS:-1}" != "1" ]]; then
    return 0
  fi
  if [[ -f pnpm-workspace.yaml ]] && grep -Eq '^[[:space:]]*dangerouslyAllowAllBuilds:' pnpm-workspace.yaml; then
    return 0
  fi
  {
    printf '\n'
    printf '# Added by @brrrd/adapter deploy harness for an ephemeral Next test app.\n'
    printf 'dangerouslyAllowAllBuilds: true\n'
  } >> pnpm-workspace.yaml
}

pm_build() {
  install_pnpm_post_build_shim
  case "$PM" in
    pnpm) run_logged "build app" pnpm build ;;
    npm) run_logged "build app" npm run build ;;
    yarn) run_logged "build app" yarn build ;;
    *) die "unsupported package manager: $PM" ;;
  esac
}

install_pnpm_post_build_shim() {
  local real_pnpm
  real_pnpm="$(command -v pnpm 2>/dev/null || true)"
  if [[ -z "$real_pnpm" ]]; then
    return 0
  fi

  mkdir -p "$HARNESS_DIR/bin"
  cat >"$HARNESS_DIR/bin/pnpm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export BRRRD_REAL_PNPM="$real_pnpm"
exec node "$ADAPTER_DIR/scripts/pnpm-post-build-shim.mjs" "\$@"
EOF
  chmod +x "$HARNESS_DIR/bin/pnpm"
  export PATH="$HARNESS_DIR/bin:$PATH"
}

resolve_brrrd_bin() {
  if [[ -n "${BRRRD_BIN:-}" ]]; then
    [[ -x "$BRRRD_BIN" ]] || die "BRRRD_BIN is not executable: $BRRRD_BIN"
    printf '%s\n' "$BRRRD_BIN"
    return 0
  fi

  local candidate
  for candidate in \
    "$ADAPTER_DIR/../brrrd/target/debug/brrrd" \
    "$ADAPTER_DIR/../brrrd/target/release/brrrd" \
    "${GITHUB_WORKSPACE:-}/brrrd/target/debug/brrrd" \
    "${GITHUB_WORKSPACE:-}/brrrd/target/release/brrrd"
  do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v brrrd >/dev/null 2>&1; then
    command -v brrrd
    return 0
  fi

  die "brrrd binary not found. Set BRRRD_BIN or checkout/build ../brrrd."
}

start_brrrd() {
  local rust_log="${BRRRD_RUST_LOG:-${RUST_LOG:-info}}"
  local env_args=("RUST_LOG=$rust_log")
  local command=("$BRRRD_BIN" "$PACKAGE_DIR" --listen "127.0.0.1:$PORT")
  if [[ -n "${BRRRD_ARGS:-}" ]]; then
    # shellcheck disable=SC2206
    local brrrd_args=(${BRRRD_ARGS})
    command+=("${brrrd_args[@]}")
  fi
  while IFS= read -r -d '' assignment; do
    env_args+=("$assignment")
  done < <(node "$ADAPTER_DIR/scripts/runtime-env.mjs")
  if command -v setsid >/dev/null 2>&1; then
    env "${env_args[@]}" \
      setsid "${command[@]}" \
      </dev/null >>"$SERVER_LOG" 2>&1 &
  else
    env "${env_args[@]}" \
      nohup "${command[@]}" \
      </dev/null >>"$SERVER_LOG" 2>&1 &
  fi
  PID="$!"
  disown "$PID" 2>/dev/null || true
}

pick_port() {
  node --input-type=module -e '
    import net from "node:net";
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      console.log(address.port);
      server.close();
    });
  '
}

write_package_dependency() {
  node --input-type=module -e '
    import fs from "node:fs";
    const adapterDir = process.env.ADAPTER_DIR;
    const pkgPath = "package.json";
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies["@brrrd/adapter"] = `file:${adapterDir}`;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  '
}

resolve_installed_adapter() {
  node --input-type=module -e '
    import { createRequire } from "node:module";
    const require = createRequire(`${process.cwd()}/package.json`);
    console.log(require.resolve("@brrrd/adapter"));
  '
}

resolve_adapter_entry() {
  if [[ -f "$ADAPTER_DIR/dist/index.js" ]]; then
    printf '%s\n' "$ADAPTER_DIR/dist/index.js"
    return
  fi
  resolve_installed_adapter
}

wait_until_ready() {
  local url="$1"
  local pid="$2"
  local attempts="${BRRRD_HARNESS_READY_ATTEMPTS:-100}"
  local delay="${BRRRD_HARNESS_READY_DELAY:-0.2}"
  local code

  for _ in $(seq 1 "$attempts"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      log "brrrd exited before becoming ready"
      tail -200 "$SERVER_LOG" >&2 || true
      return 1
    fi
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$url/" 2>/dev/null || true)"
    if [[ -n "$code" && "$code" != "000" ]]; then
      return 0
    fi
    sleep "$delay"
  done

  log "brrrd did not become ready at $url"
  tail -200 "$SERVER_LOG" >&2 || true
  return 1
}

[[ -f package.json ]] || die "e2e-deploy.sh must run from an isolated Next app directory"

mkdir -p "$HARNESS_DIR"
: >"$BUILD_LOG"
: >"$SERVER_LOG"

ADAPTER_DIR="${ADAPTER_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ADAPTER_DIR="$(cd "$ADAPTER_DIR" && pwd)"
export ADAPTER_DIR

if [[ ! -f "$ADAPTER_DIR/dist/index.js" ]]; then
  ADAPTER_PM="${ADAPTER_PM:-npm}"
  case "$ADAPTER_PM" in
    npm)
      run_logged "install local adapter dependencies" npm --prefix "$ADAPTER_DIR" install
      run_logged "compile local adapter" npm --prefix "$ADAPTER_DIR" run build
      ;;
    pnpm)
      run_logged "install local adapter dependencies" pnpm --dir "$ADAPTER_DIR" install --frozen-lockfile
      run_logged "compile local adapter" pnpm --dir "$ADAPTER_DIR" build
      ;;
    *)
      die "unsupported ADAPTER_PM: $ADAPTER_PM"
      ;;
  esac
fi

PM="${PACKAGE_MANAGER:-$(detect_package_manager)}"
write_package_dependency
pm_install

NEXT_ADAPTER_PATH="${NEXT_ADAPTER_PATH:-$(resolve_adapter_entry)}"
export NEXT_ADAPTER_PATH
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export NEXT_PRIVATE_TEST_MODE="${NEXT_PRIVATE_TEST_MODE:-e2e}"
export VERCEL_NEXT_BUNDLED_SERVER="${VERCEL_NEXT_BUNDLED_SERVER:-1}"
DEPLOYMENT_ID="${BRRRD_DEPLOYMENT_ID:-${NEXT_DEPLOYMENT_ID:-brrrd-local-$(date +%s)-$$}}"
export NEXT_DEPLOYMENT_ID="$DEPLOYMENT_ID"

pm_build

PACKAGE_DIR="${BRRRD_PACKAGE_DIR:-dist/brrrd}"
[[ -f "$PACKAGE_DIR/manifest.json" ]] || die "next build did not produce $PACKAGE_DIR/manifest.json"

BRRRD_BIN="$(resolve_brrrd_bin)"
PORT="${BRRRD_HARNESS_PORT:-$(pick_port)}"
URL="http://127.0.0.1:$PORT"
BUILD_ID="$(cat .next/BUILD_ID 2>/dev/null || printf 'undefined')"
IMMUTABLE_ASSET_TOKEN="${BRRRD_IMMUTABLE_ASSET_TOKEN:-undefined}"

{
  printf '\nBUILD_ID: %s\n' "$BUILD_ID"
  printf 'DEPLOYMENT_ID: %s\n' "$DEPLOYMENT_ID"
  printf 'IMMUTABLE_ASSET_TOKEN: %s\n' "$IMMUTABLE_ASSET_TOKEN"
  printf 'NEXT_ADAPTER_PATH: %s\n' "$NEXT_ADAPTER_PATH"
  printf 'BRRRD_PACKAGE_DIR: %s\n' "$PACKAGE_DIR"
} >>"$BUILD_LOG"

start_brrrd

PID="$PID" \
URL="$URL" \
PORT="$PORT" \
DEPLOYMENT_ID="$DEPLOYMENT_ID" \
BUILD_ID="$BUILD_ID" \
IMMUTABLE_ASSET_TOKEN="$IMMUTABLE_ASSET_TOKEN" \
PACKAGE_DIR="$PACKAGE_DIR" \
NEXT_ADAPTER_PATH="$NEXT_ADAPTER_PATH" \
DEPLOYMENT_FILE="$DEPLOYMENT_FILE" \
node --input-type=module -e '
  import fs from "node:fs";
  const data = {
    pid: Number(process.env.PID),
    url: process.env.URL,
    port: Number(process.env.PORT),
    deploymentId: process.env.DEPLOYMENT_ID,
    buildId: process.env.BUILD_ID,
    immutableAssetToken: process.env.IMMUTABLE_ASSET_TOKEN,
    packageDir: process.env.PACKAGE_DIR,
    adapterPath: process.env.NEXT_ADAPTER_PATH,
    buildLog: ".adapter-build.log",
    serverLog: ".adapter-server.log",
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(process.env.DEPLOYMENT_FILE, `${JSON.stringify(data, null, 2)}\n`);
' 

wait_until_ready "$URL" "$PID"

printf '%s\n' "$URL"
