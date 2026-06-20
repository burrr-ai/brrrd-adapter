#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const adapterDir = path.resolve(path.dirname(scriptPath), "..");
const defaultArtifactsRoot = path.join(path.dirname(adapterDir), ".brrrd-local-harness");

const defaultNextDirCandidates = [
  process.env.NEXT_DIR,
  process.env.NEXTJS_DIR,
  "/Users/ggm/work/next.js",
  "/Users/ggm/work/nextjs",
].filter(Boolean);

const defaultBrrrdBinCandidates = [
  process.env.BRRRD_BIN,
  "/Users/ggm/work/brrrd/target/debug/brrrd",
  "/Users/ggm/work/brrrd/target/release/brrrd",
].filter(Boolean);

function usage() {
  return `Usage:
  npm run harness:fixture -- --fixture test/e2e/path/to/test.ts [options]
  npm run harness:group -- --group 1/64 [options]
  node scripts/local-harness.mjs fixture --fixture test/e2e/path/to/test.ts [options]
  node scripts/local-harness.mjs group --group 1/64 [options]

Options:
  --next-dir <path>      Next.js checkout path. Default: NEXT_DIR, NEXTJS_DIR, /Users/ggm/work/next.js, /Users/ggm/work/nextjs.
  --brrrd-bin <path>     brrrd binary path. Default: BRRRD_BIN or /Users/ggm/work/brrrd/target/debug/brrrd.
  --bundler <name>       webpack, turbopack, or next-default. Default: webpack.
  --node-version <ver>   Node version for Next tests. Default: Next checkout .node-version; use "current" to disable.
  --fixture <path>       Next fixture test file path, relative to next-dir or absolute.
  --group <n/m|all>      Next run-tests shard group. Default for group mode: 1/64.
  --concurrency <n>      run-tests concurrency for group mode. Default: 1.
  --artifacts-dir <path> Artifact root. Default: ../.brrrd-local-harness.
  --name <label>         Stable artifact label. Default: derived from mode/target.
  --timeout-ms <ms>      Hard timeout for the harness child process. Default: BRRRD_LOCAL_HARNESS_TIMEOUT_MS or 3600000.
  --dry-run              Print the command and environment without executing it.
  --help                 Show this help.
`;
}

function popValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseArgs(argv, env = process.env) {
  const args = [...argv];
  let mode = null;
  if (args[0] === "fixture" || args[0] === "group") {
    mode = args.shift();
  }

  const options = {
    mode,
    nextDir: env.NEXT_DIR || env.NEXTJS_DIR || null,
    brrrdBin: env.BRRRD_BIN || env.BRRD_BIN || null,
    bundler: "webpack",
    nodeVersion: env.BRRRD_HARNESS_NODE_VERSION || env.BRRRD_LOCAL_HARNESS_NODE_VERSION || null,
    fixture: null,
    group: null,
    concurrency: "1",
    artifactsDir: env.BRRRD_HARNESS_ARTIFACTS_DIR || env.BRRD_HARNESS_ARTIFACTS_DIR || null,
    name: null,
    timeoutMs: env.BRRRD_LOCAL_HARNESS_TIMEOUT_MS || env.BRRRD_HARNESS_TIMEOUT_MS || "3600000",
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--next-dir":
      case "--next":
        options.nextDir = popValue(args, i, arg);
        i += 1;
        break;
      case "--brrrd-bin":
      case "--brrrd":
        options.brrrdBin = popValue(args, i, arg);
        i += 1;
        break;
      case "--bundler":
        options.bundler = popValue(args, i, arg);
        i += 1;
        break;
      case "--node-version":
      case "--node":
        options.nodeVersion = popValue(args, i, arg);
        i += 1;
        break;
      case "--fixture":
        options.fixture = popValue(args, i, arg);
        i += 1;
        break;
      case "--group":
        options.group = popValue(args, i, arg);
        i += 1;
        break;
      case "--concurrency":
      case "-c":
        options.concurrency = popValue(args, i, arg);
        i += 1;
        break;
      case "--artifacts-dir":
        options.artifactsDir = popValue(args, i, arg);
        i += 1;
        break;
      case "--name":
        options.name = popValue(args, i, arg);
        i += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = popValue(args, i, arg);
        i += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (!options.mode && (arg === "fixture" || arg === "group")) {
          options.mode = arg;
          break;
        }
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.mode) {
    if (options.fixture) options.mode = "fixture";
    else if (options.group) options.mode = "group";
    else throw new Error("mode is required: fixture or group");
  }
  if (options.mode === "fixture" && !options.fixture) {
    throw new Error("fixture mode requires --fixture");
  }
  if (options.mode === "group" && !options.group) {
    options.group = "1/64";
  }
  if (!["webpack", "turbopack", "next-default"].includes(options.bundler)) {
    throw new Error(`unsupported bundler: ${options.bundler}`);
  }
  if (!/^[1-9]\d*$/.test(String(options.concurrency))) {
    throw new Error(`--concurrency must be a positive integer: ${options.concurrency}`);
  }
  if (!/^[1-9]\d*$/.test(String(options.timeoutMs))) {
    throw new Error(`--timeout-ms must be a positive integer: ${options.timeoutMs}`);
  }
  return options;
}

function firstExistingFile(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function firstExistingDir(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
}

function resolveExecutable(options) {
  const brrrdBin = options.brrrdBin
    ? path.resolve(options.brrrdBin)
    : firstExistingFile(defaultBrrrdBinCandidates);
  if (!brrrdBin) {
    throw new Error("brrrd binary not found. Pass --brrrd-bin or set BRRRD_BIN.");
  }
  fs.accessSync(brrrdBin, fs.constants.X_OK);
  return brrrdBin;
}

function resolveNextDir(options) {
  const nextDir = options.nextDir
    ? path.resolve(options.nextDir)
    : firstExistingDir(defaultNextDirCandidates);
  if (!nextDir) {
    throw new Error("Next.js checkout not found. Pass --next-dir or set NEXT_DIR.");
  }
  const runTests = path.join(nextDir, "run-tests.js");
  if (!fs.existsSync(runTests)) {
    throw new Error(`Next checkout is missing run-tests.js: ${nextDir}`);
  }
  return nextDir;
}

function readNextNodeVersion(nextDir) {
  const file = path.join(nextDir, ".node-version");
  if (!fs.existsSync(file)) return null;
  const value = fs.readFileSync(file, "utf8").trim().split(/\s+/)[0];
  return value ? value.replace(/^v/, "") : null;
}

function majorOf(version) {
  const match = /^v?(\d+)/.exec(String(version || ""));
  return match ? match[1] : null;
}

export function resolveNodeRunner(
  options,
  nextDir,
  runtime = { currentVersion: process.versions.node, currentExecPath: process.execPath },
) {
  const requested = options.nodeVersion || readNextNodeVersion(nextDir);
  if (!requested || requested === "current") {
    return {
      command: runtime.currentExecPath,
      argsPrefix: [],
      selectedVersion: runtime.currentVersion,
      source: "current",
    };
  }

  const requestedMajor = majorOf(requested);
  if (requestedMajor && requestedMajor === majorOf(runtime.currentVersion)) {
    return {
      command: runtime.currentExecPath,
      argsPrefix: [],
      selectedVersion: runtime.currentVersion,
      source: "current-compatible",
    };
  }

  return {
    command: "npx",
    argsPrefix: ["-y", `node@${requested}`],
    selectedVersion: requested,
    source: "npx-node-package",
  };
}

function sanitizeLabel(value) {
  return value
    .replace(/\\/g, "/")
    .replace(/^test\/e2e\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "run";
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function artifactRunDir(options) {
  const root = path.resolve(options.artifactsDir || defaultArtifactsRoot);
  const target = options.mode === "fixture" ? options.fixture : options.group;
  const label = options.name || `${options.mode}-${options.bundler}-${target}`;
  return path.join(root, `${timestamp()}-${sanitizeLabel(label)}`);
}

export function harnessEnv({ options, nextDir, brrrdBin, artifactsDir }) {
  const tmpDir = path.join(artifactsDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const env = {
    ...process.env,
    ADAPTER_DIR: adapterDir,
    BRRRD_BIN: brrrdBin,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    NEXT_TEST_MODE: "deploy",
    NEXT_TEST_DEPLOY_SCRIPT_PATH: path.join(adapterDir, "scripts", "e2e-deploy.sh"),
    NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH: path.join(adapterDir, "scripts", "e2e-logs.sh"),
    NEXT_TEST_CLEANUP_SCRIPT_PATH: path.join(adapterDir, "scripts", "e2e-cleanup.sh"),
    NEXT_EXTERNAL_TESTS_FILTERS: "test/deploy-tests-manifest.json",
    NEXT_TEST_SKIP_RESULT_CACHE: "1",
    NEXT_E2E_TEST_TIMEOUT: process.env.NEXT_E2E_TEST_TIMEOUT || "240000",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_TEST_JOB: "1",
    HEADLESS: "true",
    NEXT_TEST_CI: "true",
    TRACE_PLAYWRIGHT: "true",
    GITHUB_WORKSPACE: artifactsDir,
  };
  delete env.IS_WEBPACK_TEST;
  delete env.IS_TURBOPACK_TEST;
  if (options.bundler === "webpack") {
    env.IS_WEBPACK_TEST = "1";
  } else if (options.bundler === "turbopack") {
    env.IS_TURBOPACK_TEST = "1";
  }
  env.BRRRD_LOCAL_HARNESS_NEXT_DIR = nextDir;
  env.BRRRD_LOCAL_HARNESS_ARTIFACTS_DIR = artifactsDir;
  return env;
}

function resolveFixture(nextDir, fixture) {
  const abs = path.isAbsolute(fixture) ? fixture : path.join(nextDir, fixture);
  if (!fs.existsSync(abs)) {
    throw new Error(`fixture file does not exist: ${abs}`);
  }
  return path.relative(nextDir, abs).split(path.sep).join("/");
}

function withNodeRunner(nodeRunner, script, args) {
  if (nodeRunner.argsPrefix.length === 0) {
    return { command: nodeRunner.command, args: [script, ...args] };
  }
  return { command: nodeRunner.command, args: [...nodeRunner.argsPrefix, script, ...args] };
}

export function buildInvocation(options, nextDir, nodeRunner = {
  command: process.execPath,
  argsPrefix: [],
  selectedVersion: process.versions.node,
  source: "current",
}) {
  if (options.mode === "fixture") {
    const fixture = resolveFixture(nextDir, options.fixture);
    const jestBin = path.join(nextDir, "node_modules", ".bin", "jest");
    const jestJs = path.join(nextDir, "node_modules", "jest", "bin", "jest.js");
    const jestArgs = ["--ci", "--runInBand", "--forceExit", "--no-cache", "--verbose", fixture];
    if (fs.existsSync(jestJs)) {
      const invocation = withNodeRunner(nodeRunner, jestJs, jestArgs);
      return { ...invocation, cwd: nextDir };
    }
    if (fs.existsSync(jestBin) && nodeRunner.argsPrefix.length === 0) {
      return { command: jestBin, args: jestArgs, cwd: nextDir };
    }
    return { command: "pnpm", args: ["exec", "jest", ...jestArgs], cwd: nextDir };
  }
  const invocation = withNodeRunner(nodeRunner, "run-tests.js", [
    "--timings",
    "-g",
    options.group,
    "-c",
    options.concurrency,
    "--type",
    "e2e",
  ]);
  return { ...invocation, cwd: nextDir };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function printDryRun({ invocation, env, artifactsDir }) {
  const shownEnv = Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => key.startsWith("NEXT_")
        || key.startsWith("BRRRD")
        || key === "ADAPTER_DIR"
        || key === "GITHUB_WORKSPACE"
        || key === "TMPDIR"
        || key === "TEMP"
        || key === "TMP"
        || key === "IS_WEBPACK_TEST"
        || key === "IS_TURBOPACK_TEST"
        || key === "HEADLESS"
        || key === "TRACE_PLAYWRIGHT"),
  );
  console.log(JSON.stringify({
    cwd: invocation.cwd,
    command: invocation.command,
    args: invocation.args,
    artifactsDir,
    env: shownEnv,
  }, null, 2));
}

function terminateProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function runProcess(invocation, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      stderr += `\n[brrrd-local-harness] timed out after ${timeoutMs}ms; terminating process group\n`;
      terminateProcessGroup(child, "SIGTERM");
      setTimeout(() => {
        if (!settled) terminateProcessGroup(child, "SIGKILL");
      }, 5000).unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += `\n[brrrd-local-harness] spawn error: ${error.message}\n`;
    });
    child.on("close", (status, signal) => {
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, status, signal, timedOut });
    });
  });
}

export async function runHarness(options) {
  const nextDir = resolveNextDir(options);
  const brrrdBin = resolveExecutable(options);
  const artifactsDir = artifactRunDir(options);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const env = harnessEnv({ options, nextDir, brrrdBin, artifactsDir });
  const nodeRunner = resolveNodeRunner(options, nextDir);
  const invocation = buildInvocation(options, nextDir, nodeRunner);
  const metadata = {
    mode: options.mode,
    bundler: options.bundler,
    nodeVersion: nodeRunner.selectedVersion,
    nodeSource: nodeRunner.source,
    fixture: options.fixture,
    group: options.group,
    concurrency: options.concurrency,
    nextDir,
    brrrdBin,
    adapterDir,
    artifactsDir,
    command: invocation.command,
    args: invocation.args,
    timeoutMs: Number(options.timeoutMs),
    startedAt: new Date().toISOString(),
  };
  writeJson(path.join(artifactsDir, "local-harness.json"), metadata);

  if (options.dryRun) {
    printDryRun({ invocation, env, artifactsDir });
    return 0;
  }

  console.error(`[brrrd-local-harness] artifacts: ${artifactsDir}`);
  console.error(`[brrrd-local-harness] cwd: ${invocation.cwd}`);
  console.error(`[brrrd-local-harness] $ ${[invocation.command, ...invocation.args].join(" ")}`);

  const result = await runProcess(invocation, env, Number(options.timeoutMs));
  fs.writeFileSync(path.join(artifactsDir, "stdout.log"), result.stdout ?? "");
  fs.writeFileSync(path.join(artifactsDir, "stderr.log"), result.stderr ?? "");
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  writeJson(path.join(artifactsDir, "local-harness-result.json"), {
    ...metadata,
    finishedAt: new Date().toISOString(),
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
  });
  if (result.timedOut) return 124;
  return result.status ?? 1;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    process.exitCode = await runHarness(options);
  } catch (error) {
    console.error(`[brrrd-local-harness] ${error.message}`);
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
