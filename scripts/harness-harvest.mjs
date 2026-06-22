#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  harnessEnv,
  resolveExecutable,
  resolveNextDir,
  resolveNodeRunner,
} from "./local-harness.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const adapterDir = path.resolve(path.dirname(scriptPath), "..");
const defaultArtifactsRoot = path.join(path.dirname(adapterDir), ".brrrd-local-harness");
const localHarnessScript = path.join(adapterDir, "scripts", "local-harness.mjs");
const defaultLedgerFile = path.join(adapterDir, "docs", "next-harness-failure-ledger.jsonl");

function usage() {
  return `Usage:
  npm run harness:harvest -- --groups 6/64,7/64 --bundlers webpack,turbopack [options]
  node scripts/harness-harvest.mjs --groups 6/64,7/64 --bundlers webpack [options]

Options:
  --groups <list>        Comma-separated run-tests groups, e.g. 6/64,7/64. Required.
  --fixtures <list>      Comma-separated fixture files to run directly instead of shard groups.
  --fixture-list <path>  Newline-delimited fixture files to run directly. Lines starting with # are ignored.
  --bundlers <list>      Comma-separated bundlers: webpack,turbopack,next-default. Default: webpack.
  --parallel <n>         Number of local harness processes to run concurrently. Default: 2.
  --concurrency <n>      run-tests fixture concurrency inside each group. Default: 1.
  --timeout-ms <ms>      Per-group hard timeout passed to local-harness. Default: 1800000.
  --defer-after-ms <ms>  Keep slow targets running but stop counting them against --parallel after this age. Default: 0 (disabled).
  --max-deferred-running <n>
                         Maximum deferred targets that can keep running while new targets start. Default: 2.
  --cleanup-target-artifacts <never|passed|always>
                         Remove heavy local-harness run artifacts after target completion. Default: passed.
  --list-parallel <n>    Fixture-list discovery concurrency for --expand-fixtures. Default: --parallel.
  --list-timeout-ms <ms> Per-group fixture discovery timeout. Default: 300000.
  --slow-ms <ms>         Mark targets slower than this as slow. Default: 600000.
  --next-dir <path>      Next.js checkout path, forwarded to local-harness.
  --brrrd-bin <path>     brrrd binary path, forwarded to local-harness.
  --node-version <ver>   Node version for Next tests, forwarded to local-harness.
  --artifacts-dir <dir>  Artifact root. Default: ../.brrrd-local-harness.
  --ledger-file <path>   Append/update persistent failure ledger. Default: docs/next-harness-failure-ledger.jsonl.
  --no-ledger            Do not update the persistent failure ledger.
  --name <label>         Harvest label. Default: harvest.
  --expand-fixtures      Expand each shard group with run-tests --print-tests and harvest fixtures directly.
  --capture-context      Persist Adapter API context diagnostics for each deploy.
  --dry-run              Print planned targets without executing.
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

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw new Error(`${name} must be a positive integer: ${value}`);
  }
  return Number(value);
}

export function parseArgs(argv, env = process.env) {
  const options = {
    groups: [],
    fixtures: [],
    bundlers: splitList(env.BRRRD_HARVEST_BUNDLERS || "webpack"),
    parallel: env.BRRRD_HARVEST_PARALLEL || "2",
    concurrency: env.BRRRD_HARVEST_GROUP_CONCURRENCY || "1",
    timeoutMs: env.BRRRD_HARVEST_TIMEOUT_MS || "1800000",
    deferAfterMs: env.BRRRD_HARVEST_DEFER_AFTER_MS || "0",
    maxDeferredRunning: env.BRRRD_HARVEST_MAX_DEFERRED_RUNNING || "2",
    cleanupTargetArtifacts: env.BRRRD_HARVEST_CLEANUP_TARGET_ARTIFACTS || "passed",
    listParallel: env.BRRRD_HARVEST_LIST_PARALLEL || null,
    listTimeoutMs: env.BRRRD_HARVEST_LIST_TIMEOUT_MS || "300000",
    slowMs: env.BRRRD_HARVEST_SLOW_MS || "600000",
    nextDir: env.NEXT_DIR || env.NEXTJS_DIR || null,
    brrrdBin: env.BRRRD_BIN || env.BRRD_BIN || null,
    nodeVersion: env.BRRRD_HARNESS_NODE_VERSION || env.BRRRD_LOCAL_HARNESS_NODE_VERSION || null,
    artifactsDir: env.BRRRD_HARNESS_ARTIFACTS_DIR || env.BRRD_HARNESS_ARTIFACTS_DIR || null,
    ledgerFile: env.BRRRD_HARVEST_LEDGER_FILE || defaultLedgerFile,
    updateLedger: env.BRRRD_HARVEST_LEDGER === "0" ? false : true,
    name: "harvest",
    expandFixtures: false,
    captureContext: env.BRRRD_HARNESS_CAPTURE_CONTEXT === "1",
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--groups":
        options.groups = splitList(popValue(argv, i, arg));
        i += 1;
        break;
      case "--fixtures":
        options.fixtures.push(...splitList(popValue(argv, i, arg)));
        i += 1;
        break;
      case "--fixture-list": {
        const filePath = popValue(argv, i, arg);
        const list = fs.readFileSync(filePath, "utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("#"));
        options.fixtures.push(...list);
        i += 1;
        break;
      }
      case "--bundlers":
        options.bundlers = splitList(popValue(argv, i, arg));
        i += 1;
        break;
      case "--parallel":
        options.parallel = popValue(argv, i, arg);
        i += 1;
        break;
      case "--concurrency":
      case "-c":
        options.concurrency = popValue(argv, i, arg);
        i += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = popValue(argv, i, arg);
        i += 1;
        break;
      case "--defer-after-ms":
        options.deferAfterMs = popValue(argv, i, arg);
        i += 1;
        break;
      case "--max-deferred-running":
        options.maxDeferredRunning = popValue(argv, i, arg);
        i += 1;
        break;
      case "--cleanup-target-artifacts":
        options.cleanupTargetArtifacts = popValue(argv, i, arg);
        i += 1;
        break;
      case "--list-parallel":
        options.listParallel = popValue(argv, i, arg);
        i += 1;
        break;
      case "--list-timeout-ms":
        options.listTimeoutMs = popValue(argv, i, arg);
        i += 1;
        break;
      case "--slow-ms":
        options.slowMs = popValue(argv, i, arg);
        i += 1;
        break;
      case "--next-dir":
      case "--next":
        options.nextDir = popValue(argv, i, arg);
        i += 1;
        break;
      case "--brrrd-bin":
      case "--brrrd":
        options.brrrdBin = popValue(argv, i, arg);
        i += 1;
        break;
      case "--node-version":
      case "--node":
        options.nodeVersion = popValue(argv, i, arg);
        i += 1;
        break;
      case "--artifacts-dir":
        options.artifactsDir = popValue(argv, i, arg);
        i += 1;
        break;
      case "--ledger-file":
        options.ledgerFile = popValue(argv, i, arg);
        options.updateLedger = true;
        i += 1;
        break;
      case "--no-ledger":
        options.updateLedger = false;
        break;
      case "--name":
        options.name = popValue(argv, i, arg);
        i += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--expand-fixtures":
        options.expandFixtures = true;
        break;
      case "--capture-context":
        options.captureContext = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.help) return options;
  options.fixtures = [...new Set(options.fixtures)];
  if (options.groups.length === 0 && options.fixtures.length === 0) {
    throw new Error("--groups or --fixtures is required");
  }
  if (options.bundlers.length === 0) throw new Error("--bundlers must include at least one bundler");
  for (const bundler of options.bundlers) {
    if (!["webpack", "turbopack", "next-default"].includes(bundler)) {
      throw new Error(`unsupported bundler: ${bundler}`);
    }
  }
  positiveInteger(options.parallel, "--parallel");
  positiveInteger(options.concurrency, "--concurrency");
  positiveInteger(options.timeoutMs, "--timeout-ms");
  if (!/^\d+$/.test(String(options.deferAfterMs))) {
    throw new Error(`--defer-after-ms must be a non-negative integer: ${options.deferAfterMs}`);
  }
  positiveInteger(options.maxDeferredRunning, "--max-deferred-running");
  if (!["never", "passed", "always"].includes(options.cleanupTargetArtifacts)) {
    throw new Error(`--cleanup-target-artifacts must be never, passed, or always: ${options.cleanupTargetArtifacts}`);
  }
  options.listParallel ??= options.parallel;
  positiveInteger(options.listParallel, "--list-parallel");
  positiveInteger(options.listTimeoutMs, "--list-timeout-ms");
  positiveInteger(options.slowMs, "--slow-ms");
  return options;
}

function ledgerStateFileFor(ledgerFile) {
  if (ledgerFile.endsWith(".jsonl")) return ledgerFile.replace(/\.jsonl$/, ".state.json");
  return `${ledgerFile}.state.json`;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function ledgerKey({ bundler, fixture }) {
  return `${bundler}|${fixture}`;
}

function appendJsonLines(file, entries) {
  if (entries.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function compactMessages(messages, limit = 12) {
  return [...new Set(messages ?? [])].slice(0, limit);
}

function extractFixtureTitles(fixture, nextDir, limit = 8) {
  if (!fixture?.startsWith("test/")) return [];
  try {
    const source = fs.readFileSync(path.join(nextDir, fixture), "utf8");
    const titles = [];
    const patterns = [
      /\b(?:describe|it|test)\s*(?:\.\w+)?\s*\(\s*'([^']+)'/g,
      /\b(?:describe|it|test)\s*(?:\.\w+)?\s*\(\s*"([^"]+)"/g,
      /\b(?:describe|it|test)\s*(?:\.\w+)?\s*\(\s*`([^`]+)`/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        titles.push(match[1]);
        if (titles.length >= limit) return titles;
      }
    }
    return titles;
  } catch {
    return [];
  }
}

function sanitizeLabel(value) {
  return value
    .replace(/\\/g, "/")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "run";
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function stableHash(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function targetName(parts) {
  const label = parts.map((part) => sanitizeLabel(String(part))).filter(Boolean).join("-");
  return `${label.slice(0, 150)}-${stableHash(parts.join("|"))}`;
}

export function buildTargets(options) {
  if (options.fixtures.length > 0) {
    return options.bundlers.flatMap((bundler) =>
      options.fixtures.map((fixture) => ({
        kind: "fixture",
        bundler,
        group: "fixture",
        fixture,
        name: targetName([options.name, bundler, "fixture", fixture]),
      }))
    );
  }
  return options.bundlers.flatMap((bundler) =>
    options.groups.map((group) => ({
      kind: "group",
      bundler,
      group,
      name: targetName([options.name, bundler, group]),
    }))
  );
}

export function parsePrintedTests(output) {
  const fixtures = [];
  let inList = false;
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "Running tests:") {
      inList = true;
      continue;
    }
    if (!inList) continue;
    if (/^total:\s+\d+/i.test(line)) break;
    if (/^test\/.+\.test\.[cm]?[jt]sx?$/.test(line)) {
      fixtures.push(line);
    }
  }
  return [...new Set(fixtures)];
}

function withNodeRunner(nodeRunner, script, args) {
  if (nodeRunner.argsPrefix.length === 0) {
    return { command: nodeRunner.command, args: [script, ...args] };
  }
  return { command: nodeRunner.command, args: [...nodeRunner.argsPrefix, script, ...args] };
}

export function extractFailedFixtures(output) {
  const failures = new Map();
  const patterns = [
    /^test\/.+?\.test\.[tj]sx? failed due to .+$/gm,
    /^test\/.+?\.test\.[tj]sx? failed to pass within \d+ retries$/gm,
    /^FAIL\s+\S+\s+(test\/.+?\.test\.[tj]sx?)(?:\s|\(|$)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const line = match[0];
      const fixture = match[1] ?? line.split(/\s+/)[0];
      const current = failures.get(fixture) ?? { fixture, messages: [] };
      current.messages.push(line);
      failures.set(fixture, current);
    }
  }
  return [...failures.values()];
}

export function extractFailureHints(output, limit = 24) {
  const hints = [];
  const patterns = [
    /\[brrrd-harness\].*failed/i,
    /Error:/,
    /Expected:/,
    /Expected substring:/,
    /Expected a response containing/,
    /Received:/,
    /Received string:/,
    /static prerender HTML served without invoking the handler/i,
    /This page could not be found/i,
    /Not Found/,
    /next-test-fetch-priority/i,
    /priority/i,
    /_rsc|RSC|prefetch/i,
    /Proxy Phase Failed/i,
    /native Node addons|\b\.node\b|node_sqlite3/i,
  ];
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (patterns.some((pattern) => pattern.test(line))) {
      hints.push(line);
      if (hints.length >= limit) break;
    }
  }
  return hints;
}

export function failureDigestForTarget(target, failures, output, status) {
  if (target.kind !== "fixture" || status === 0) return failures;
  const hints = extractFailureHints(output);
  if (failures.length === 0 && hints.length > 0) {
    return [{ fixture: target.fixture, messages: hints }];
  }
  if (failures.length === 0) return failures;
  return failures.map((failure) => failure.fixture === target.fixture
    ? { ...failure, messages: [...failure.messages, ...hints] }
    : failure);
}

export function extractLocalHarnessArtifactDirs(output) {
  const dirs = [];
  for (const match of String(output || "").matchAll(/^\[brrrd-local-harness\]\s+artifacts:\s+(.+)$/gm)) {
    dirs.push(match[1].trim());
  }
  return [...new Set(dirs)];
}

const DIAGNOSTIC_HINT_FILES = new Set([
  "adapter-build.log",
  "adapter-server.log",
]);

function walkDiagnosticFiles(root, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkDiagnosticFiles(file, out);
      continue;
    }
    if (entry.isFile() && DIAGNOSTIC_HINT_FILES.has(entry.name)) out.push(file);
  }
  return out;
}

function readTail(file, maxBytes = 200_000) {
  const data = fs.readFileSync(file);
  const start = Math.max(0, data.length - maxBytes);
  return data.subarray(start).toString("utf8");
}

export function diagnosticFailureTextForLocalHarnessArtifacts(output) {
  const parts = [];
  for (const artifactDir of extractLocalHarnessArtifactDirs(output)) {
    const diagnosticsDir = path.join(artifactDir, "harness-diagnostics");
    for (const file of walkDiagnosticFiles(diagnosticsDir)) {
      const text = readTail(file).trim();
      if (!text) continue;
      parts.push([
        `[brrrd-harvest] diagnostic ${path.relative(artifactDir, file).split(path.sep).join("/")}`,
        text,
      ].join("\n"));
    }
  }
  return parts.join("\n");
}

function cleanupTargetArtifacts(result, policy) {
  if (policy === "never") return [];
  if (policy === "passed" && result.status !== 0) return [];
  const cleaned = [];
  for (const artifactDir of extractLocalHarnessArtifactDirs(`${result.stdout}\n${result.stderr}`)) {
    try {
      fs.rmSync(artifactDir, { recursive: true, force: true });
      cleaned.push(artifactDir);
    } catch (error) {
      const text = `\n[brrrd-harvest] failed to cleanup target artifact ${artifactDir}: ${error.message}\n`;
      fs.appendFileSync(result.logs.stderr, text);
    }
  }
  return cleaned;
}

export function suggestBucket(failure) {
  const text = `${failure.fixture}\n${(failure.messages ?? []).join("\n")}`;
  if (/app-dir\/segment-cache\/|partial-prefetching-config|interception-route-prefetch-cache|parallel-routes-root-param-dynamic-child|optimistic-routing/i.test(text)) {
    return "segment-cache/PPR prefetch";
  }
  if (/static prerender HTML served without invoking the handler does not exist|\.next\/server\/pages\/.*\.html/i.test(text)) {
    return "Pages data route";
  }
  if (/middleware|proxy/i.test(failure.fixture)) {
    return "middleware/proxy";
  }
  if (/app-root-params-getters|generate-static-params|root params/i.test(text)) {
    return "App root params";
  }
  if (/dynamic-route-interpolation|interpolation/i.test(text)) {
    return "dynamic route interpolation";
  }
  if (/server-asset-modules|asset module/i.test(text)) {
    return "server asset modules";
  }
  if (/This page could not be found|Received string:\s+"Not Found"|_not-found|global 404|fake-link/i.test(text)) {
    return "App not-found fallback";
  }
  if (/uri encoded|%20|escaping the uri encoded query params|encoded query/i.test(text)) {
    return "RSC prefetch URL encoding";
  }
  if (/static page was prefetched|should not fetch again|prefetch cache|using cached prefetch/i.test(text)) {
    return "RSC prefetch cache semantics";
  }
  if (/next-test-fetch-priority|priority/i.test(text)) {
    return "RSC prefetch request metadata";
  }
  if (/native Node addons|\b\.node\b|node_sqlite3|sqlite3.*native/i.test(text)) {
    return "Node/runtime API";
  }
  if (/No loader is configured|Build failed with \d+ error|esbuild|\.map|turbopack|chunk|module|bundle/i.test(text)) {
    return "bundler output shape";
  }
  if (/prefetch|next-router-prefetch|_rsc|RSC|PPR|instant/i.test(text)) {
    return "PPR/instant prefetch";
  }
  if (/middleware|proxy/i.test(text)) {
    return "middleware/proxy";
  }
  if (/i18n|locale|basePath|basepath/i.test(text)) {
    return "i18n/basePath";
  }
  if (/metadata|favicon|icon|apple-icon|static file/i.test(text)) {
    return "metadata/static asset";
  }
  if (/timeout|timed out|flaky|port|ECONNREFUSED|browser has been closed/i.test(text)) {
    return "flaky infra";
  }
  return "unclassified";
}

function decorateFailures(result) {
  if (result.deferred && result.signal === "DEFERRED_HARVEST_EXIT") {
    return [{
      bundler: result.bundler,
      group: result.group,
      kind: result.kind,
      ...(result.fixture ? { targetFixture: result.fixture } : {}),
      fixture: result.fixture ?? `${result.kind}:${result.bundler}:${result.group}`,
      bucket: "slow fixture",
      messages: [
        `target deferred after ${result.deferAfterMs ?? "unknown"}ms and was stopped so harvest can continue`,
      ],
    }];
  }

  const extractedFailures = failureDigestForTarget(
    { kind: result.kind, fixture: result.fixture },
    result.failures,
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    result.status,
  );
  const failures = extractedFailures.length > 0 || result.status === 0
    ? extractedFailures
    : [{
      fixture: result.fixture ?? `${result.kind}:${result.bundler}:${result.group}`,
      messages: [`${result.kind} target exited with status ${result.status ?? "signal"}${result.signal ? ` signal ${result.signal}` : ""}, but no failed fixture inventory was parsed`],
    }];
  return failures.map((failure) => ({
    bundler: result.bundler,
    group: result.group,
    kind: result.kind,
    ...(result.fixture ? { targetFixture: result.fixture } : {}),
    fixture: failure.fixture,
    bucket: suggestBucket(failure),
    messages: failure.messages,
  }));
}

function activeTargetView(target) {
  return {
    kind: target.kind,
    bundler: target.bundler,
    group: target.group,
    ...(target.fixture ? { fixture: target.fixture } : {}),
    name: target.name,
    startedAt: target.startedAt,
    ...(target.deferred ? {
      deferred: true,
      deferredAt: target.deferredAt,
      deferAfterMs: target.deferAfterMs,
    } : {}),
  };
}

function runningElapsedMs(target, nowMs) {
  const startedMs = Date.parse(target.startedAt);
  if (!Number.isFinite(startedMs)) return null;
  return Math.max(0, nowMs - startedMs);
}

function slowRunningTargetView(target, nowMs) {
  const elapsedMs = runningElapsedMs(target, nowMs);
  return {
    ...activeTargetView(target),
    ...(elapsedMs == null ? {} : { elapsedMs }),
  };
}

export function createSummary({
  results,
  running = [],
  pending = [],
  startedAt,
  finishedAt,
  slowMs,
  abortedSignal = null,
  deferredExit = false,
  now = new Date().toISOString(),
}) {
  const failures = results.flatMap(decorateFailures);
  const nowMs = Date.parse(now);
  const runningTargets = running.map(activeTargetView);
  const slowRunningTargets = Number.isFinite(nowMs)
    ? running
      .filter((target) => (runningElapsedMs(target, nowMs) ?? 0) >= slowMs)
      .map((target) => slowRunningTargetView(target, nowMs))
    : [];
  return {
    startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    ...(abortedSignal ? { abortedSignal } : {}),
    ...(deferredExit ? { deferredExit: true } : {}),
    status: abortedSignal
      ? "aborted"
      : finishedAt
        ? failures.length === 0 ? "pass" : "fail"
        : "running",
    resultCount: results.length,
    failureCount: failures.length,
    failures,
    buckets: failures.reduce((acc, failure) => {
      acc[failure.bucket] = (acc[failure.bucket] ?? 0) + 1;
      return acc;
    }, {}),
    slowTargets: results
      .filter((result) => result.elapsedMs >= slowMs)
      .map(({ kind, bundler, group, fixture, name, elapsedMs }) => ({
        kind,
        bundler,
        group,
        ...(fixture ? { fixture } : {}),
        name,
        elapsedMs,
      })),
    slowRunningTargets,
    deferredTargets: runningTargets.filter((target) => target.deferred),
    running: runningTargets,
    pending,
    results: results.map(({ stdout: _stdout, stderr: _stderr, ...result }) => ({
      ...result,
      failures: decorateFailures({ ...result, stdout: _stdout, stderr: _stderr }).map((failure) => ({
        ...failure,
        bucket: suggestBucket(failure),
      })),
    })),
  };
}

export function updateFailureLedger({
  summary,
  ledgerFile,
  harvestDir,
  nextDir,
  now = new Date().toISOString(),
}) {
  const stateFile = ledgerStateFileFor(ledgerFile);
  const previous = readJsonFile(stateFile, {
    schemaVersion: 1,
    entries: {},
  });
  const entries = { ...(previous.entries ?? {}) };
  const events = [];
  const failedKeys = new Set();
  const completedTargets = [];

  function eventBase(type, patch) {
    return {
      schemaVersion: 1,
      event: type,
      at: now,
      harvestDir,
      summaryStatus: summary.status,
      ...patch,
    };
  }

  function upsertFailure(result, failure) {
    const record = {
      bundler: failure.bundler ?? result.bundler,
      group: failure.group ?? result.group,
      kind: failure.kind ?? result.kind,
      fixture: failure.fixture,
      bucket: failure.bucket ?? suggestBucket(failure),
      messages: compactMessages(failure.messages),
      targetFixture: failure.targetFixture ?? result.fixture,
      targetName: result.name,
      logs: result.logs,
      testTitles: extractFixtureTitles(failure.fixture, nextDir),
    };
    const id = ledgerKey(record);
    failedKeys.add(id);
    const prior = entries[id];
    const event = prior?.status === "open" ? "still-open" : prior ? "reopened" : "opened";
    entries[id] = {
      ...(prior ?? {
        id,
        firstSeenAt: now,
        firstSeenRun: harvestDir,
        failureCount: 0,
        passCount: 0,
      }),
      ...record,
      id,
      status: "open",
      lastSeenAt: now,
      lastSeenRun: harvestDir,
      lastFailureAt: now,
      lastFailureRun: harvestDir,
      failureCount: (prior?.failureCount ?? 0) + 1,
      closedAt: null,
      closedByRun: null,
    };
    events.push(eventBase(event, {
      id,
      ...record,
      previousStatus: prior?.status ?? null,
    }));
  }

  for (const result of summary.results ?? []) {
    const failures = decorateFailures(result);
    for (const failure of failures) upsertFailure(result, failure);
    if (result.status === 0 || failures.length > 0) {
      completedTargets.push({
        bundler: result.bundler,
        group: result.group,
        kind: result.kind,
        fixture: result.fixture,
        partialTestNamePattern: result.partialTestNamePattern,
        name: result.name,
        status: result.status,
        logs: result.logs,
      });
      if (result.partialTestNamePattern) {
        events.push(eventBase("partial-pass", {
          bundler: result.bundler,
          group: result.group,
          kind: result.kind,
          fixture: result.fixture,
          testNamePattern: result.partialTestNamePattern,
          target: {
            kind: result.kind,
            bundler: result.bundler,
            group: result.group,
            fixture: result.fixture,
            name: result.name,
            status: result.status,
            logs: result.logs,
          },
        }));
      }
    }
  }

  function closeEntry(id, entry, target, reason) {
    entries[id] = {
      ...entry,
      status: "closed",
      lastSeenAt: now,
      lastSeenRun: harvestDir,
      lastVerifiedAt: now,
      lastVerifiedRun: harvestDir,
      closedAt: now,
      closedByRun: harvestDir,
      closeReason: reason,
      passCount: (entry.passCount ?? 0) + 1,
      verifiedByTarget: {
        kind: target.kind,
        bundler: target.bundler,
        group: target.group,
        ...(target.fixture ? { fixture: target.fixture } : {}),
        name: target.name,
        status: target.status,
        logs: target.logs,
      },
    };
    events.push(eventBase("closed", {
      id,
      bundler: entry.bundler,
      group: entry.group,
      fixture: entry.fixture,
      bucket: entry.bucket,
      reason,
      target: entries[id].verifiedByTarget,
    }));
  }

  for (const target of completedTargets) {
    if (target.status !== 0 && !target.fixture) continue;
    if (target.partialTestNamePattern) continue;
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.status !== "open") continue;
      if (failedKeys.has(id)) continue;
      if (entry.bundler !== target.bundler) continue;
      if (target.fixture) {
        if (entry.fixture !== target.fixture) continue;
        closeEntry(id, entry, target, "fixture passed in later harvest");
      } else if (entry.group === target.group) {
        closeEntry(id, entry, target, "group completed without this fixture failing");
      }
    }
  }

  const state = {
    schemaVersion: 1,
    updatedAt: now,
    harvestDir,
    ledgerFile,
    summary: {
      status: summary.status,
      resultCount: summary.resultCount,
      failureCount: summary.failureCount,
      buckets: summary.buckets,
    },
    counts: Object.values(entries).reduce((acc, entry) => {
      acc[entry.status] = (acc[entry.status] ?? 0) + 1;
      return acc;
    }, {}),
    entries,
  };

  appendJsonLines(ledgerFile, events);
  writeJson(stateFile, state);
  return { ledgerFile, stateFile, eventCount: events.length, state };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function runCapture(invocation, env, timeoutMs, logFiles) {
  return new Promise((resolve) => {
    if (logFiles.stdout) fs.writeFileSync(logFiles.stdout, "");
    if (logFiles.stderr) fs.writeFileSync(logFiles.stderr, "");

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
      const message = `\n[brrrd-harvest] fixture list timed out after ${timeoutMs}ms\n`;
      stderr += message;
      fs.appendFileSync(logFiles.stderr, message);
      terminateProcessGroup(child, "SIGTERM");
      setTimeout(() => {
        if (!settled) terminateProcessGroup(child, "SIGKILL");
      }, 5000).unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      fs.appendFileSync(logFiles.stdout, text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      fs.appendFileSync(logFiles.stderr, text);
    });
    child.on("error", (error) => {
      const message = `\n[brrrd-harvest] fixture list spawn error: ${error.message}\n`;
      stderr += message;
      fs.appendFileSync(logFiles.stderr, message);
    });
    child.on("close", (status, signal) => {
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, status, signal, timedOut });
    });
  });
}

export async function listGroupFixtures({ options, bundler, group, harvestDir }) {
  const nextDir = resolveNextDir(options);
  const brrrdBin = resolveExecutable(options);
  const nodeRunner = resolveNodeRunner(options, nextDir);
  const listDir = path.join(harvestDir, "fixture-lists", `${sanitizeLabel(bundler)}-${sanitizeLabel(group)}`);
  fs.mkdirSync(listDir, { recursive: true });
  const env = harnessEnv({
    options: { ...options, bundler },
    nextDir,
    brrrdBin,
    artifactsDir: listDir,
  });
  const invocation = {
    ...withNodeRunner(nodeRunner, "run-tests.js", [
      "--timings",
      "-g",
      group,
      "-c",
      "1",
      "--type",
      "e2e",
      "--print-tests",
    ]),
    cwd: nextDir,
  };

  const result = await runCapture(invocation, env, Number(options.listTimeoutMs), {
    stdout: path.join(listDir, "stdout.log"),
    stderr: path.join(listDir, "stderr.log"),
  });
  const fixtures = parsePrintedTests(`${result.stdout}\n${result.stderr}`);
  writeJson(path.join(listDir, "fixtures.json"), {
    bundler,
    group,
    command: invocation.command,
    args: invocation.args,
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    fixtures,
  });
  if (result.timedOut) {
    throw new Error(`fixture list timed out for ${bundler} ${group}`);
  }
  if ((result.status ?? 0) !== 0) {
    throw new Error(`fixture list failed for ${bundler} ${group}; see ${listDir}`);
  }
  if (fixtures.length === 0) {
    throw new Error(`fixture list was empty for ${bundler} ${group}; see ${listDir}`);
  }
  return fixtures;
}

export async function buildHarvestTargets(options, harvestDir, deps = {}) {
  if (options.fixtures.length > 0) return buildTargets(options);
  if (!options.expandFixtures) return buildTargets(options);
  const getFixtures = deps.listGroupFixtures ?? listGroupFixtures;
  const groups = options.bundlers.flatMap((bundler) =>
    options.groups.map((group) => ({ bundler, group }))
  );
  const listed = await mapWithConcurrency(
    groups,
    Number(options.listParallel),
    async ({ bundler, group }) => {
      const fixtures = await getFixtures({ options, bundler, group, harvestDir });
      return { bundler, group, fixtures };
    },
  );

  const targets = [];
  for (const { bundler, group, fixtures } of listed) {
    for (const fixture of fixtures) {
      targets.push({
        kind: "fixture",
        bundler,
        group,
        fixture,
        name: targetName([options.name, bundler, group, fixture]),
      });
    }
  }
  return targets;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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

function runTarget(target, options, harvestDir) {
  let abortChild = () => {};
  const promise = new Promise((resolve) => {
    const startedAt = new Date();
    const targetLogDir = path.join(harvestDir, "target-logs");
    fs.mkdirSync(targetLogDir, { recursive: true });
    const stdoutLog = path.join(targetLogDir, `${target.name}.stdout.log`);
    const stderrLog = path.join(targetLogDir, `${target.name}.stderr.log`);
    fs.writeFileSync(stdoutLog, "");
    fs.writeFileSync(stderrLog, "");

    const args = [
      localHarnessScript,
      target.kind === "fixture" ? "fixture" : "group",
    ];
    if (target.kind === "fixture") {
      args.push("--fixture", target.fixture);
    } else {
      args.push("--group", target.group);
    }
    args.push(
      "--bundler",
      target.bundler,
      "--name",
      target.name,
      "--timeout-ms",
      String(options.timeoutMs),
      "--artifacts-dir",
      path.join(harvestDir, "runs"),
    );
    if (target.kind !== "fixture") {
      args.push("--concurrency", String(options.concurrency));
    }
    if (options.nextDir) args.push("--next-dir", options.nextDir);
    if (options.brrrdBin) args.push("--brrrd-bin", options.brrrdBin);
    if (options.nodeVersion) args.push("--node-version", options.nodeVersion);
    if (options.captureContext) args.push("--capture-context");
    const child = spawn(process.execPath, args, {
      cwd: adapterDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let abortedSignal = null;
    let settled = false;

    abortChild = function abortChildForSignal(signal) {
      if (settled) return;
      abortedSignal = signal;
      const text = `\n[brrrd-harvest] received ${signal}; terminating ${target.name}\n`;
      stderr += text;
      fs.appendFileSync(stderrLog, text);
      terminateProcessGroup(child, "SIGTERM");
      setTimeout(() => {
        if (!settled) terminateProcessGroup(child, "SIGKILL");
      }, 5000).unref();
    };

    const onSigint = () => abortChild("SIGINT");
    const onSigterm = () => abortChild("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      fs.appendFileSync(stdoutLog, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      fs.appendFileSync(stderrLog, text);
    });
    child.on("error", (error) => {
      const text = `\n[brrrd-harvest] spawn error: ${error.message}\n`;
      stderr += text;
      fs.appendFileSync(stderrLog, text);
    });
    child.on("close", (status, signal) => {
      settled = true;
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      const finishedAt = new Date();
      const combined = `${stdout}\n${stderr}`;
      const diagnosticText = diagnosticFailureTextForLocalHarnessArtifacts(combined);
      if (diagnosticText) {
        const text = `\n${diagnosticText}\n`;
        stderr += text;
        fs.appendFileSync(stderrLog, text);
      }
      const failureOutput = diagnosticText ? `${combined}\n${diagnosticText}` : combined;
      const result = {
        ...target,
        status,
        signal: abortedSignal ?? signal,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        elapsedMs: finishedAt.getTime() - startedAt.getTime(),
        logs: {
          stdout: stdoutLog,
          stderr: stderrLog,
        },
        failures: failureDigestForTarget(
          target,
          extractFailedFixtures(failureOutput),
          failureOutput,
          status,
        ),
        stdout,
        stderr,
      };
      result.cleanedArtifacts = cleanupTargetArtifacts(result, options.cleanupTargetArtifacts);
      resolve(result);
    });
  });
  promise.abort = abortChild;
  return promise;
}

export function resultCollisionKey(target) {
  if (target.fixture) return `fixture:${target.fixture}`;
  return `group:${target.group}`;
}

export function takeNextRunnableTarget(pending, runningTargets) {
  const activeKeys = new Set(runningTargets.map((target) => resultCollisionKey(target)));
  const index = pending.findIndex((target) => !activeKeys.has(resultCollisionKey(target)));
  if (index === -1) return null;
  return pending.splice(index, 1)[0];
}

export function shouldExitForDeferredTargets({
  pendingCount,
  runningTargets,
  maxDeferredRunning,
}) {
  if (pendingCount !== 0) return false;
  if (runningTargets.length === 0) return false;
  const deferredCount = runningTargets.filter((target) => target.deferred).length;
  return deferredCount > 0
    && deferredCount === runningTargets.length
    && deferredCount <= maxDeferredRunning;
}

async function runQueue(targets, options, harvestDir) {
  const pending = [...targets];
  const running = new Map();
  const deferred = new Map();
  const tasks = new Map();
  const results = [];
  const startedAt = new Date().toISOString();
  let abortedSignal = null;
  const limit = Number(options.parallel);
  const deferAfterMs = Number(options.deferAfterMs);
  const maxDeferredRunning = Number(options.maxDeferredRunning);
  let deferredExit = false;

  function writePartial() {
    writeJson(path.join(harvestDir, "harvest-partial.json"), createSummary({
      results,
      running: [...running.values()],
      pending,
      startedAt,
      slowMs: Number(options.slowMs),
      abortedSignal,
    }));
  }

  function blockingRunningCount() {
    let count = 0;
    for (const target of running.values()) {
      if (!target.deferred) count += 1;
    }
    return count;
  }

  function deferredRunningCount() {
    let count = 0;
    for (const target of running.values()) {
      if (target.deferred) count += 1;
    }
    return count;
  }

  function markDeferredTargets() {
    if (deferAfterMs <= 0) return false;
    const now = Date.now();
    let changed = false;
    let deferredCount = deferredRunningCount();
    for (const target of running.values()) {
      if (target.deferred || deferredCount >= maxDeferredRunning) continue;
      const elapsedMs = runningElapsedMs(target, now);
      if (elapsedMs == null || elapsedMs < deferAfterMs) continue;
      const deferredAt = new Date(now).toISOString();
      target.deferred = true;
      target.deferredAt = deferredAt;
      target.deferAfterMs = deferAfterMs;
      deferred.set(target.name, {
        deferred: true,
        deferredAt,
        deferAfterMs,
      });
      deferredCount += 1;
      changed = true;
      const label = target.fixture ? `${target.group} ${target.fixture}` : target.group;
      console.error(
        `[brrrd-harvest] deferring ${target.bundler} ${label} after ${elapsedMs}ms; continuing with other targets`,
      );
    }
    if (changed) writePartial();
    return changed;
  }

  function abortQueue(signal) {
    if (abortedSignal) return;
    abortedSignal = signal;
    console.error(`[brrrd-harvest] received ${signal}; no new targets will be started`);
    writePartial();
  }

  const onSigint = () => abortQueue("SIGINT");
  const onSigterm = () => abortQueue("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  async function startNext() {
    if (abortedSignal) return false;
    const target = takeNextRunnableTarget(pending, [...running.values()]);
    if (!target) return false;
    running.set(target.name, {
      kind: target.kind,
      bundler: target.bundler,
      group: target.group,
      fixture: target.fixture,
      name: target.name,
      resultCollisionKey: resultCollisionKey(target),
      startedAt: new Date().toISOString(),
      deferred: false,
    });
    writePartial();
    const targetTask = runTarget(target, options, harvestDir);
    const task = targetTask
      .then((result) => {
        const deferredInfo = deferred.get(target.name);
        if (deferredInfo) Object.assign(result, deferredInfo);
        results.push(result);
        running.delete(target.name);
        deferred.delete(target.name);
        writePartial();
        const targetLabel = result.fixture ? `${result.group} ${result.fixture}` : result.group;
        console.error(
          `[brrrd-harvest] ${result.bundler} ${targetLabel} status=${result.status} failures=${result.failures.length} elapsedMs=${result.elapsedMs}`,
        );
      })
      .finally(() => {
        running.delete(target.name);
        deferred.delete(target.name);
        tasks.delete(target.name);
        writePartial();
      });
    task.abort = targetTask.abort;
    tasks.set(target.name, task);
    return true;
  }

  try {
    while (pending.length > 0 || running.size > 0) {
      markDeferredTargets();
      let started = false;
      while (!abortedSignal && pending.length > 0 && blockingRunningCount() < limit) {
        const didStart = await startNext();
        if (!didStart) break;
        started = true;
      }
      if (!abortedSignal && shouldExitForDeferredTargets({
        pendingCount: pending.length,
        runningTargets: [...running.values()],
        maxDeferredRunning,
      })) {
        deferredExit = true;
        console.error(
          `[brrrd-harvest] only ${deferredRunningCount()} deferred target(s) remain; stopping them so harvest can continue`,
        );
        for (const [name, task] of tasks) {
          const target = running.get(name);
          if (target?.deferred && typeof task.abort === "function") {
            task.abort("DEFERRED_HARVEST_EXIT");
          }
        }
        await Promise.allSettled([...tasks.values()]);
        break;
      }
      if (tasks.size > 0) {
        await Promise.race([
          ...tasks.values(),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      } else if (abortedSignal) {
        break;
      } else if (!started && pending.length > 0) {
        throw new Error("harvest scheduler could not start a pending target");
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
  return { results, startedAt, abortedSignal, pending, deferredExit };
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

export async function runHarvest(options) {
  const root = path.resolve(options.artifactsDir || defaultArtifactsRoot);
  const harvestDir = path.join(root, `${timestamp()}-${sanitizeLabel(options.name)}`);
  if (!options.dryRun || options.expandFixtures) {
    fs.mkdirSync(harvestDir, { recursive: true });
  }
  const targets = await buildHarvestTargets(options, harvestDir);

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ targets }, null, 2)}\n`);
    return 0;
  }

  writeJson(path.join(harvestDir, "harvest-plan.json"), {
    options,
    targets,
    startedAt: new Date().toISOString(),
  });
  console.error(`[brrrd-harvest] artifacts: ${harvestDir}`);
  console.error(`[brrrd-harvest] targets: ${targets.length}, parallel=${options.parallel}`);

  const { results, startedAt, abortedSignal, pending, deferredExit } = await runQueue(targets, options, harvestDir);
  const summary = createSummary({
    results,
    pending,
    startedAt,
    finishedAt: new Date().toISOString(),
    slowMs: Number(options.slowMs),
    abortedSignal,
    deferredExit,
  });
  writeJson(path.join(harvestDir, "harvest-summary.json"), summary);
  if (options.updateLedger) {
    const ledger = updateFailureLedger({
      summary,
      ledgerFile: path.resolve(options.ledgerFile || defaultLedgerFile),
      harvestDir,
      nextDir: resolveNextDir(options),
    });
    console.error(
      `[brrrd-harvest] ledger events=${ledger.eventCount} file=${ledger.ledgerFile} state=${ledger.stateFile}`,
    );
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (abortedSignal) return signalExitCode(abortedSignal);
  return summary.failureCount === 0 ? 0 : 1;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    process.exitCode = await runHarvest(options);
  } catch (error) {
    console.error(`[brrrd-harvest] ${error.message}`);
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
