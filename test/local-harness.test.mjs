import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  artifactRunDir,
  buildInvocation,
  harnessEnv,
  parseArgs,
} from "../scripts/local-harness.mjs";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function fakeNextCheckout() {
  const dir = tempDir("brrrd-local-next-");
  fs.writeFileSync(path.join(dir, "run-tests.js"), "");
  const fixture = path.join(dir, "test", "e2e", "sample", "sample.test.ts");
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, "");
  const jest = path.join(dir, "node_modules", ".bin", "jest");
  fs.mkdirSync(path.dirname(jest), { recursive: true });
  fs.writeFileSync(jest, "#!/usr/bin/env node\n");
  fs.chmodSync(jest, 0o755);
  return dir;
}

test("parseArgs supports fixture mode with explicit local paths", () => {
  const options = parseArgs([
    "fixture",
    "--fixture",
    "test/e2e/sample/sample.test.ts",
    "--next-dir",
    "/tmp/next",
    "--brrrd-bin",
    "/tmp/brrrd",
    "--bundler",
    "turbopack",
    "--artifacts-dir",
    "/tmp/artifacts",
  ], {});

  assert.equal(options.mode, "fixture");
  assert.equal(options.fixture, "test/e2e/sample/sample.test.ts");
  assert.equal(options.nextDir, "/tmp/next");
  assert.equal(options.brrrdBin, "/tmp/brrrd");
  assert.equal(options.bundler, "turbopack");
  assert.equal(options.artifactsDir, "/tmp/artifacts");
});

test("parseArgs defaults group mode to 1/64 and rejects unknown bundlers", () => {
  const options = parseArgs(["group"], {});
  assert.equal(options.mode, "group");
  assert.equal(options.group, "1/64");

  assert.throws(
    () => parseArgs(["group", "--bundler", "magic"], {}),
    /unsupported bundler/,
  );
});

test("buildInvocation runs a single fixture through Jest", () => {
  const nextDir = fakeNextCheckout();
  const options = parseArgs([
    "fixture",
    "--fixture",
    "test/e2e/sample/sample.test.ts",
  ], {});

  const invocation = buildInvocation(options, nextDir);

  assert.equal(invocation.cwd, nextDir);
  assert.equal(invocation.command, path.join(nextDir, "node_modules", ".bin", "jest"));
  assert.deepEqual(invocation.args.slice(0, 5), [
    "--ci",
    "--runInBand",
    "--forceExit",
    "--no-cache",
    "--verbose",
  ]);
  assert.equal(invocation.args.at(-1), "test/e2e/sample/sample.test.ts");
});

test("buildInvocation runs shard groups through Next run-tests.js", () => {
  const nextDir = fakeNextCheckout();
  const options = parseArgs(["group", "--group", "9/64", "--concurrency", "2"], {});

  const invocation = buildInvocation(options, nextDir);

  assert.equal(invocation.cwd, nextDir);
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [
    "run-tests.js",
    "--timings",
    "-g",
    "9/64",
    "-c",
    "2",
    "--type",
    "e2e",
  ]);
});

test("harnessEnv wires official deploy scripts and bundler axis", () => {
  const nextDir = fakeNextCheckout();
  const options = parseArgs(["group", "--bundler", "webpack"], {});
  const env = harnessEnv({
    options,
    nextDir,
    brrrdBin: "/tmp/brrrd-bin",
    artifactsDir: "/tmp/artifacts",
  });

  assert.equal(env.ADAPTER_DIR.endsWith("brrrd-adapter"), true);
  assert.match(env.NEXT_TEST_DEPLOY_SCRIPT_PATH, /scripts\/e2e-deploy\.sh$/);
  assert.match(env.NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH, /scripts\/e2e-logs\.sh$/);
  assert.match(env.NEXT_TEST_CLEANUP_SCRIPT_PATH, /scripts\/e2e-cleanup\.sh$/);
  assert.equal(env.NEXT_E2E_TEST_TIMEOUT, "240000");
  assert.equal(env.BRRRD_BIN, "/tmp/brrrd-bin");
  assert.equal(env.GITHUB_WORKSPACE, "/tmp/artifacts");
  assert.equal(env.TMPDIR, "/tmp/artifacts/tmp");
  assert.equal(env.TEMP, "/tmp/artifacts/tmp");
  assert.equal(env.TMP, "/tmp/artifacts/tmp");
  assert.equal(env.IS_WEBPACK_TEST, "1");
  assert.equal(env.IS_TURBOPACK_TEST, undefined);
});

test("artifactRunDir derives a stable readable target label", () => {
  const options = parseArgs([
    "fixture",
    "--fixture",
    "test/e2e/i18n-ignore-rewrite-source-locale/rewrites.test.ts",
    "--artifacts-dir",
    "/tmp/brrrd-artifacts",
  ], {});

  const dir = artifactRunDir(options);

  assert.equal(path.dirname(dir), "/tmp/brrrd-artifacts");
  assert.match(path.basename(dir), /fixture-webpack-test-e2e-i18n-ignore-rewrite-source-locale-rewrites\.test\.ts$/);
});
