import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { forwardedBrrrdEnvAssignments } from "../scripts/runtime-env.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("runtime env helper forwards app env through brrrd service env names", () => {
  assert.deepEqual(
    forwardedBrrrdEnvAssignments({
      ANOTHER_MIDDLEWARE_TEST: "asdf2",
      STRING_ENV_VAR: "asdf3",
      MIDDLEWARE_TEST: "asdf",
      NEXT_DEPLOYMENT_ID: "deploy-1",
      NEXT_TEST_JOB: "1",
      NEXT_RUNTIME: "nodejs",
      BRRRD_BIN: "/tmp/brrrd",
      GITHUB_WORKSPACE: "/tmp/workspace",
      PATH: "/bin",
    }).sort(),
    [
      "BRRRD_ENV_ANOTHER_MIDDLEWARE_TEST=asdf2",
      "BRRRD_ENV_MIDDLEWARE_TEST=asdf",
      "BRRRD_ENV_NEXT_DEPLOYMENT_ID=deploy-1",
      "BRRRD_ENV_STRING_ENV_VAR=asdf3",
    ],
  );
});

test("e2e-logs prefers final harness markers over build-time echoes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-harness-logs-"));
  fs.mkdirSync(path.join(dir, ".brrrd-harness"));
  fs.writeFileSync(
    path.join(dir, ".adapter-build.log"),
    [
      "BUILD_ID: build-from-next",
      "DEPLOYMENT_ID: undefined",
      "IMMUTABLE_ASSET_TOKEN: undefined",
      "BUILD_ID: build-from-harness",
      "DEPLOYMENT_ID: brrrd-local-test",
      "IMMUTABLE_ASSET_TOKEN: immutable-token",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, ".adapter-server.log"), "");
  fs.writeFileSync(
    path.join(dir, ".brrrd-harness", "deployment.json"),
    "{}\n",
  );

  const out = execFileSync(path.join(repoRoot, "scripts", "e2e-logs.sh"), {
    cwd: dir,
    encoding: "utf8",
  });

  assert.match(out, /^BUILD_ID: build-from-harness$/m);
  assert.match(out, /^DEPLOYMENT_ID: brrrd-local-test$/m);
  assert.match(out, /^IMMUTABLE_ASSET_TOKEN: immutable-token$/m);
  assert.doesNotMatch(out.split("\n").slice(0, 3).join("\n"), /undefined/);
});

test("e2e-logs persists route and runtime manifests into diagnostics", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-harness-diags-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-harness-workspace-"));
  const files = [
    ".adapter-build.log",
    ".adapter-server.log",
    ".brrrd-harness/deployment.json",
    ".next/routes-manifest.json",
    ".next/prerender-manifest.json",
    ".next/build-manifest.json",
    ".next/app-build-manifest.json",
    ".next/server/app-paths-manifest.json",
    ".next/server/pages-manifest.json",
    ".next/server/middleware-manifest.json",
    "dist/brrrd/manifest.json",
    "dist/brrrd/adapter-context.json",
  ];
  for (const file of files) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "{}\n");
  }

  execFileSync(path.join(repoRoot, "scripts", "e2e-logs.sh"), {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_WORKSPACE: workspace },
  });

  const liveRoot = path.join(workspace, "harness-diagnostics", "live");
  const runDirs = fs.readdirSync(liveRoot);
  assert.equal(runDirs.length, 1);
  const runDir = path.join(liveRoot, runDirs[0]);
  for (const file of files) {
    const copied = path.join(runDir, file.replace(/^\./, ""));
    assert.equal(fs.existsSync(copied), true, `${file} should be copied`);
  }
});

test("e2e-cleanup persists final runtime logs into diagnostics", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-harness-cleanup-"));
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "brrrd-harness-workspace-"),
  );
  const files = [
    ".adapter-build.log",
    ".adapter-server.log",
    ".brrrd-harness/deployment.json",
    "dist/brrrd/manifest.json",
  ];
  for (const file of files) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, ".adapter-build.log"), "build log\n");
  fs.writeFileSync(
    path.join(dir, ".adapter-server.log"),
    "final runtime request log\n",
  );
  fs.writeFileSync(
    path.join(dir, ".brrrd-harness", "deployment.json"),
    JSON.stringify({ pid: 99999999 }) + "\n",
  );
  fs.writeFileSync(path.join(dir, "dist/brrrd/manifest.json"), "{}\n");

  execFileSync(path.join(repoRoot, "scripts", "e2e-cleanup.sh"), {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_WORKSPACE: workspace },
  });

  const finalRoot = path.join(workspace, "harness-diagnostics", "final");
  const runDirs = fs.readdirSync(finalRoot);
  assert.equal(runDirs.length, 1);
  const runDir = path.join(finalRoot, runDirs[0]);
  for (const file of files) {
    const copied = path.join(runDir, file.replace(/^\./, ""));
    assert.equal(fs.existsSync(copied), true, `${file} should be copied`);
  }
  assert.match(
    fs.readFileSync(path.join(runDir, "adapter-server.log"), "utf8"),
    /final runtime request log/,
  );
});
