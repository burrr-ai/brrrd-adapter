import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

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
