import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { onBuildComplete } from "../dist/build.js";
import {
  hostPathToPosix,
  normalizeRequiredServerFiles,
  relativePosix,
  toPosixPath,
} from "../dist/posix-path.js";

// What `next build` on Windows writes: Next derives these with the host's
// path.relative / path.join, so they carry `\` separators.
const WIN_PROJECT = "C:\\Users\\dev\\app";
const WIN_DIST = path.win32.join(WIN_PROJECT, ".next");
const WIN_SUPPORT = path.win32.join(WIN_PROJECT, "node_modules", ".cache", "@brrrd", "adapter");
const WIN_LEGACY_HANDLER = path.win32.relative(
  WIN_DIST,
  path.win32.join(WIN_SUPPORT, "cache-handler-legacy.mjs"),
);
const WIN_MODERN_HANDLER = path.win32.relative(
  WIN_DIST,
  path.win32.join(WIN_SUPPORT, "cache-handler.mjs"),
);

function windowsRequiredServerFiles() {
  return {
    version: 1,
    config: {
      distDir: ".next",
      cacheHandler: WIN_LEGACY_HANDLER,
      cacheHandlers: { default: WIN_MODERN_HANDLER },
      cacheMaxMemorySize: 0,
      deploymentId: "dpl_test",
      outputFileTracingRoot: WIN_PROJECT,
    },
    appDir: WIN_PROJECT,
    relativeAppDir: path.win32.join("apps", "web"),
    files: [
      path.win32.join(".next", "routes-manifest.json"),
      path.win32.join(".next", "server", "middleware-manifest.json"),
    ],
    ignore: [],
  };
}

test("fixture really carries Windows separators", () => {
  assert.equal(WIN_LEGACY_HANDLER, "..\\node_modules\\.cache\\@brrrd\\adapter\\cache-handler-legacy.mjs");
});

test("toPosixPath and relativePosix drop Windows separators", () => {
  assert.equal(toPosixPath(WIN_LEGACY_HANDLER), "../node_modules/.cache/@brrrd/adapter/cache-handler-legacy.mjs");
  const rel = relativePosix(WIN_DIST, path.win32.join(WIN_SUPPORT, "cache-handler-legacy.mjs"), path.win32);
  assert.equal(rel, "../node_modules/.cache/@brrrd/adapter/cache-handler-legacy.mjs");
  assert.equal(rel.includes("\\"), false);
});

test("hostPathToPosix rewrites only when the host separator is a backslash", () => {
  const winTarget = path.win32.join(WIN_SUPPORT, "cache-handler-legacy.mjs");
  assert.equal(
    hostPathToPosix(winTarget, path.win32),
    "C:/Users/dev/app/node_modules/.cache/@brrrd/adapter/cache-handler-legacy.mjs",
  );
  // On POSIX a backslash is a legal filename character, so keep it.
  assert.equal(hostPathToPosix("/srv/app/odd\\name.mjs", path.posix), "/srv/app/odd\\name.mjs");
});

test("normalizeRequiredServerFiles rewrites Windows cache handler and file paths", () => {
  const input = windowsRequiredServerFiles();
  const { manifest, changed } = normalizeRequiredServerFiles(input);

  assert.equal(changed, true);
  assert.equal(manifest.config.cacheHandler, "../node_modules/.cache/@brrrd/adapter/cache-handler-legacy.mjs");
  assert.equal(manifest.config.cacheHandlers.default, "../node_modules/.cache/@brrrd/adapter/cache-handler.mjs");
  assert.equal(manifest.relativeAppDir, "apps/web");
  assert.deepEqual(manifest.files, [".next/routes-manifest.json", ".next/server/middleware-manifest.json"]);
  for (const value of [
    manifest.config.cacheHandler,
    manifest.config.cacheHandlers.default,
    manifest.relativeAppDir,
    ...manifest.files,
  ]) {
    assert.equal(value.includes("\\"), false, value);
  }
  // Host-absolute fields describe the build machine and are left as-is.
  assert.equal(manifest.appDir, WIN_PROJECT);
  assert.equal(manifest.config.outputFileTracingRoot, WIN_PROJECT);
  // Input is not mutated.
  assert.equal(input.config.cacheHandler, WIN_LEGACY_HANDLER);
});

test("normalizeRequiredServerFiles leaves POSIX manifests untouched", () => {
  const input = {
    version: 1,
    config: {
      distDir: ".next",
      cacheHandler: "../node_modules/.cache/@brrrd/adapter/cache-handler-legacy.mjs",
      cacheHandlers: {},
    },
    files: [".next/routes-manifest.json"],
  };
  const { manifest, changed } = normalizeRequiredServerFiles(input);
  assert.equal(changed, false);
  assert.equal(manifest, input);
});

test("onBuildComplete packages a Windows-built required-server-files.json with POSIX paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-adapter-windows-paths-"));
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  fs.writeFileSync(handler, "export function handler(_req, res) { res.end('ok'); }\n", "utf8");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, "required-server-files.json"),
    JSON.stringify(windowsRequiredServerFiles()),
    "utf8",
  );

  await onBuildComplete({
    routing: {
      beforeMiddleware: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: null,
    },
    outputs: {
      pages: [],
      appPages: [{ id: "/", pathname: "/", filePath: handler, assets: {} }],
      appRoutes: [],
      pagesApi: [],
      prerenders: [],
      staticFiles: [],
    },
    projectDir: root,
    repoRoot: root,
    distDir,
    config: {},
    nextVersion: "16.2.0",
    buildId: "test-build",
  });

  const outDir = path.join(root, "dist", "brrrd");
  const packaged = fs.readFileSync(
    path.join(outDir, "runtime", ".next", "required-server-files.json"),
    "utf8",
  );
  const parsed = JSON.parse(packaged);
  assert.equal(parsed.config.cacheHandler, "../node_modules/.cache/@brrrd/adapter/cache-handler-legacy.mjs");
  assert.equal(parsed.config.cacheHandlers.default, "../node_modules/.cache/@brrrd/adapter/cache-handler.mjs");
  assert.equal(parsed.config.deploymentId, "dpl_test");

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  const artifact = manifest.artifacts.find((item) => item.id === "runtime-root:required-server-files.json");
  assert.ok(artifact);
  assert.equal(artifact.packagePath, "runtime/.next/required-server-files.json");
  assert.equal(artifact.sourcePath, ".next/required-server-files.json");
  for (const item of manifest.artifacts) {
    assert.equal(item.packagePath.includes("\\"), false, item.packagePath);
    assert.equal(item.mountPath.includes("\\"), false, item.mountPath);
  }
});
