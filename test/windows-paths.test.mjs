import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { onBuildComplete } from "../dist/build.js";
import {
  hostPathToPosix,
  normalizeWindowsRequiredServerFiles,
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
const ESCAPED_IGNORE = "cache/\\[literal\\].js";

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
    ignore: [ESCAPED_IGNORE],
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

test("relativePosix preserves literal backslashes in POSIX filenames", () => {
  assert.equal(
    relativePosix("/srv/app/.next", "/srv/app/local\\cache.mjs", path.posix),
    "../local\\cache.mjs",
  );
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

test("normalizeWindowsRequiredServerFiles rewrites relative paths and preserves glob escapes", () => {
  const input = windowsRequiredServerFiles();
  const crossDriveHandler = "D:\\cache\\handler.mjs";
  const uncHandler = "\\\\server\\share\\handler.mjs";
  input.config.cacheHandlers.crossDrive = crossDriveHandler;
  input.config.cacheHandlers.unc = uncHandler;
  const { manifest, changed } = normalizeWindowsRequiredServerFiles(input);

  assert.equal(changed, true);
  assert.equal(manifest.config.cacheHandler, "../node_modules/.cache/@brrrd/adapter/cache-handler-legacy.mjs");
  assert.equal(manifest.config.cacheHandlers.default, "../node_modules/.cache/@brrrd/adapter/cache-handler.mjs");
  assert.equal(manifest.relativeAppDir, "apps/web");
  assert.deepEqual(manifest.files, [".next/routes-manifest.json", ".next/server/middleware-manifest.json"]);
  assert.deepEqual(manifest.ignore, [ESCAPED_IGNORE]);
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
  assert.equal(manifest.config.cacheHandlers.crossDrive, crossDriveHandler);
  assert.equal(manifest.config.cacheHandlers.unc, uncHandler);
  // Input is not mutated.
  assert.equal(input.config.cacheHandler, WIN_LEGACY_HANDLER);
});

test("normalizeWindowsRequiredServerFiles leaves already normalized paths untouched", () => {
  const input = {
    version: 1,
    config: {
      distDir: ".next",
      cacheHandler: "../node_modules/.cache/@brrrd/adapter/cache-handler-legacy.mjs",
      cacheHandlers: {},
    },
    files: [".next/routes-manifest.json"],
  };
  const { manifest, changed } = normalizeWindowsRequiredServerFiles(input);
  assert.equal(changed, false);
  assert.equal(manifest, input);
});

async function packageRequiredServerFiles(t, source, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-adapter-windows-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  fs.writeFileSync(handler, "export function handler(_req, res) { res.end('ok'); }\n", "utf8");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "required-server-files.json"), source);

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
  }, options);

  return path.join(root, "dist", "brrrd");
}

test("onBuildComplete packages a Windows-built required-server-files.json with POSIX paths", async (t) => {
  const outDir = await packageRequiredServerFiles(t, JSON.stringify(windowsRequiredServerFiles()), {
    windowsBuildHost: true,
  });
  const packaged = fs.readFileSync(
    path.join(outDir, "runtime", ".next", "required-server-files.json"),
    "utf8",
  );
  const parsed = JSON.parse(packaged);
  assert.equal(parsed.config.cacheHandler, "../node_modules/.cache/@brrrd/adapter/cache-handler-legacy.mjs");
  assert.equal(parsed.config.cacheHandlers.default, "../node_modules/.cache/@brrrd/adapter/cache-handler.mjs");
  assert.equal(parsed.config.deploymentId, "dpl_test");
  assert.deepEqual(parsed.ignore, [ESCAPED_IGNORE]);

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

test("onBuildComplete copies a POSIX-built required-server-files.json byte-for-byte", async (t) => {
  const manifest = {
    version: 1,
    config: { cacheHandler: "../local\\cache.mjs" },
    relativeAppDir: "apps/west\\coast",
    ignore: [ESCAPED_IGNORE],
  };
  const source = Buffer.from(JSON.stringify(manifest, null, 2) + "\r\n");
  const options = path.sep === "\\" ? { windowsBuildHost: false } : undefined;
  const outDir = await packageRequiredServerFiles(t, source, options);
  const packaged = fs.readFileSync(path.join(outDir, "runtime", ".next", "required-server-files.json"));
  assert.deepEqual(packaged, source);
});
