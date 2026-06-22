#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSummary, updateFailureLedger } from "./harness-harvest.mjs";
import { resolveNextDir } from "./local-harness.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const adapterDir = path.resolve(path.dirname(scriptPath), "..");
const defaultLedgerFile = path.join(adapterDir, "docs", "next-harness-failure-ledger.jsonl");

function usage() {
  return `Usage:
  node scripts/harness-ledger.mjs import-summary --summary <harvest-summary.json> [options]
  node scripts/harness-ledger.mjs import-local-harness --result <local-harness-result.json> [options]
  node scripts/harness-ledger.mjs state [options]

Options:
  --summary <path>       Harvest summary JSON to import.
  --result <path>        Local harness result JSON to import.
  --ledger-file <path>   Ledger event log. Default: docs/next-harness-failure-ledger.jsonl.
  --harvest-dir <path>   Harvest artifact dir. Default: summary parent directory.
  --next-dir <path>      Next.js checkout path, used to extract fixture titles.
  --open                 With "state", print open entries only.
  --help                 Show this help.
`;
}

function popValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    command,
    summary: null,
    result: null,
    ledgerFile: defaultLedgerFile,
    harvestDir: null,
    nextDir: null,
    open: false,
    help: command === "--help" || command === "-h" || !command,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    switch (arg) {
      case "--summary":
        options.summary = popValue(rest, i, arg);
        i += 1;
        break;
      case "--result":
        options.result = popValue(rest, i, arg);
        i += 1;
        break;
      case "--ledger-file":
        options.ledgerFile = popValue(rest, i, arg);
        i += 1;
        break;
      case "--harvest-dir":
        options.harvestDir = popValue(rest, i, arg);
        i += 1;
        break;
      case "--next-dir":
        options.nextDir = popValue(rest, i, arg);
        i += 1;
        break;
      case "--open":
        options.open = true;
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
  if (!["import-summary", "import-local-harness", "state"].includes(options.command)) {
    throw new Error(`unknown command: ${options.command}`);
  }
  if (options.command === "import-summary" && !options.summary) {
    throw new Error("import-summary requires --summary");
  }
  if (options.command === "import-local-harness" && !options.result) {
    throw new Error("import-local-harness requires --result");
  }
  return options;
}

function ledgerStateFileFor(ledgerFile) {
  if (ledgerFile.endsWith(".jsonl")) return ledgerFile.replace(/\.jsonl$/, ".state.json");
  return `${ledgerFile}.state.json`;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function elapsedMsFromResult(result) {
  const started = Date.parse(result.startedAt);
  const finished = Date.parse(result.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, finished - started);
}

function readTextIfExists(file) {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8");
}

function testNamePatternFromLocalHarness(local) {
  if (typeof local.testNamePattern === "string" && local.testNamePattern.length > 0) {
    return local.testNamePattern;
  }
  const args = Array.isArray(local.args) ? local.args : [];
  const index = args.indexOf("--testNamePattern");
  const value = index >= 0 ? args[index + 1] : null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const ledgerFile = path.resolve(options.ledgerFile);
  if (options.command === "import-summary") {
    const summaryFile = path.resolve(options.summary);
    const summary = loadJson(summaryFile);
    const harvestDir = path.resolve(options.harvestDir ?? path.dirname(summaryFile));
    const nextDir = resolveNextDir({ nextDir: options.nextDir });
    const result = updateFailureLedger({
      summary,
      ledgerFile,
      harvestDir,
      nextDir,
    });
    process.stdout.write(`${JSON.stringify({
      ledgerFile: result.ledgerFile,
      stateFile: result.stateFile,
      eventCount: result.eventCount,
      counts: result.state.counts,
      summary: result.state.summary,
    }, null, 2)}\n`);
    return;
  }

  if (options.command === "import-local-harness") {
    const resultFile = path.resolve(options.result);
    const local = loadJson(resultFile);
    const harvestDir = path.resolve(options.harvestDir ?? local.artifactsDir ?? path.dirname(resultFile));
    const testNamePattern = testNamePatternFromLocalHarness(local);
    const result = {
      kind: local.mode,
      bundler: local.bundler,
      group: local.group,
      fixture: local.fixture,
      ...(testNamePattern ? { partialTestNamePattern: testNamePattern } : {}),
      name: path.basename(harvestDir),
      status: local.status,
      signal: local.signal,
      elapsedMs: elapsedMsFromResult(local),
      logs: {
        stdout: path.join(harvestDir, "stdout.log"),
        stderr: path.join(harvestDir, "stderr.log"),
      },
      failures: [],
      stdout: readTextIfExists(path.join(harvestDir, "stdout.log")),
      stderr: readTextIfExists(path.join(harvestDir, "stderr.log")),
    };
    const summary = createSummary({
      startedAt: local.startedAt,
      finishedAt: local.finishedAt,
      slowMs: 0,
      results: [result],
    });
    const nextDir = resolveNextDir({ nextDir: options.nextDir ?? local.nextDir });
    const imported = updateFailureLedger({
      summary,
      ledgerFile,
      harvestDir,
      nextDir,
    });
    process.stdout.write(`${JSON.stringify({
      ledgerFile: imported.ledgerFile,
      stateFile: imported.stateFile,
      eventCount: imported.eventCount,
      counts: imported.state.counts,
      summary: imported.state.summary,
    }, null, 2)}\n`);
    return;
  }

  const stateFile = ledgerStateFileFor(ledgerFile);
  const state = loadJson(stateFile);
  const entries = Object.values(state.entries ?? {});
  const filtered = options.open ? entries.filter((entry) => entry.status === "open") : entries;
  process.stdout.write(`${JSON.stringify({
    stateFile,
    counts: state.counts,
    entries: filtered.map((entry) => ({
      status: entry.status,
      bundler: entry.bundler,
      group: entry.group,
      fixture: entry.fixture,
      bucket: entry.bucket,
      lastSeenAt: entry.lastSeenAt,
      closedAt: entry.closedAt,
    })),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`[brrrd-ledger] ${error.message}`);
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  }
}
