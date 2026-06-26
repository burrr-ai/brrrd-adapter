// Regression for the comwit.io 500: a Turbopack build that externalizes a
// node_modules package materializes a hashed symlink alias under
// `.next/node_modules/<alias>` and the built server imports the alias name
// (e.g. `@libsql/client-<hash>/web`). The adapter must:
//   (1) materialize SCOPED aliases (`@scope/name-<hash>`), not just unscoped
//       ones — the `@scope` entry is a real dir, the alias under it is the
//       symlink (the original fix only checked top-level symlinks, so scoped
//       aliases like @libsql/client-<hash> were silently dropped), and
//   (2) fail the build (preflight) if any imported synthetic alias was NOT
//       materialized, so a broken bundle never ships.
//
// These are build-output assertions (lowest layer, no full app build).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createArtifactPlan } from "../dist/artifact-planner.js";
import {
  checkExternalAliasPreflight,
  syntheticAliasOf,
} from "../dist/external-preflight.js";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `brrrd-alias-${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

// Build a real package the alias symlinks to, then symlink a scoped alias to it.
function buildScopedAliasTree(root) {
  const distDir = path.join(root, ".next");
  // The real package lives under node_modules (NFT-traced location).
  const realPkg = path.join(root, "node_modules", "@libsql", "client");
  fs.mkdirSync(path.join(realPkg, "lib-esm"), { recursive: true });
  writeJson(path.join(realPkg, "package.json"), {
    name: "@libsql/client",
    type: "module",
    exports: {
      ".": { import: "./lib-esm/node.js" },
      "./web": { import: "./lib-esm/web.js" },
    },
  });
  fs.writeFileSync(path.join(realPkg, "lib-esm", "web.js"), "export const web = 1;\n", "utf8");
  fs.writeFileSync(path.join(realPkg, "lib-esm", "node.js"), "export const node = 1;\n", "utf8");

  // Turbopack's externalized alias: a real `@libsql` dir holding a SYMLINK to
  // the real package under a hashed name.
  const aliasScope = path.join(distDir, "node_modules", "@libsql");
  fs.mkdirSync(aliasScope, { recursive: true });
  fs.symlinkSync(realPkg, path.join(aliasScope, "client-7664182d7c51b711"), "dir");
  return { distDir };
}

function minimalModel(root, distDir) {
  return {
    routing: {
      beforeMiddleware: [], beforeFiles: [], afterFiles: [],
      dynamicRoutes: [], onMatch: [], fallback: [],
      shouldNormalizeNextData: false, rsc: null,
    },
    outputs: {
      pages: [], appPages: [], appRoutes: [], pagesApi: [],
      prerenders: [], staticFiles: [],
    },
    projectDir: root,
    repoRoot: root,
    distDir,
    config: {},
    nextVersion: "16.2.7",
    buildId: "test-build",
  };
}

const emptySupplement = {
  staticResponseMeta: [], dynamicPrerenderRoutes: [], appPrerenderDataRoutes: [],
  pprSegmentPrefetchRoutes: [], rewriteSupplement: undefined,
  staticRouteSupplement: [], pprPages: [], preview: undefined,
  edgeFunctions: [], middleware: undefined,
};

test("scoped Turbopack alias (@scope/name-<hash>) is materialized under runtime node_modules", () => {
  const root = tempDir("scoped-materialize");
  const { distDir } = buildScopedAliasTree(root);
  const outDir = path.join(root, "dist", "brrrd");

  const plan = createArtifactPlan(
    minimalModel(root, distDir), emptySupplement, new Map(), outDir,
    { hasAppBundle: false },
  );

  const aliasItems = plan.items.filter((i) =>
    i.mountPath?.startsWith("node_modules/@libsql/client-7664182d7c51b711/"));
  assert.ok(aliasItems.length > 0, "scoped alias files must be planned");

  const webEntry = aliasItems.find((i) =>
    i.mountPath === "node_modules/@libsql/client-7664182d7c51b711/lib-esm/web.js");
  assert.ok(webEntry, "the `/web` subpath entry must be materialized");
  assert.ok(
    aliasItems.some((i) =>
      i.mountPath === "node_modules/@libsql/client-7664182d7c51b711/package.json"),
    "package.json must be materialized so exports/subpaths resolve",
  );
});

test("syntheticAliasOf distinguishes hashed aliases from ordinary specifiers", () => {
  assert.equal(
    syntheticAliasOf("@libsql/client-7664182d7c51b711/web"),
    "@libsql/client-7664182d7c51b711",
  );
  assert.equal(
    syntheticAliasOf("firebase-1a2b3c4d5e6f7a8b/firestore"),
    "firebase-1a2b3c4d5e6f7a8b",
  );
  // Ordinary specifiers must NOT be treated as synthetic aliases.
  assert.equal(syntheticAliasOf("react"), null);
  assert.equal(syntheticAliasOf("@libsql/client/web"), null);
  assert.equal(syntheticAliasOf("next/dist/compiled/@vercel/og/index.node.js"), null);
  assert.equal(syntheticAliasOf("./relative"), null);
  assert.equal(syntheticAliasOf("node:fs"), null);
  // A package with a short version-like suffix is not a hash (12+ hex required).
  assert.equal(syntheticAliasOf("lodash-es/merge"), null);
});

test("preflight flags an imported synthetic alias that was NOT materialized", () => {
  const outDir = tempDir("preflight-missing");
  const chunkDir = path.join(outDir, "runtime", ".next", "server", "chunks");
  fs.mkdirSync(chunkDir, { recursive: true });
  // A raw Turbopack chunk that externalImports the hashed alias, but no
  // runtime/node_modules/@libsql/client-<hash> was packaged.
  fs.writeFileSync(
    path.join(chunkDir, "root.js"),
    `module.exports=[909048,e=>e.a(async(t,r)=>{let x=await e.y("@libsql/client-7664182d7c51b711/web");r()},!0)];`,
    "utf8",
  );

  const { refs, unresolved } = checkExternalAliasPreflight(outDir);
  assert.equal(refs.length, 1, "the synthetic alias import should be detected");
  assert.equal(unresolved.length, 1, "and reported unresolved (not materialized)");
  assert.equal(unresolved[0].alias, "@libsql/client-7664182d7c51b711");
});

test("preflight passes once the alias is materialized under runtime node_modules", () => {
  const outDir = tempDir("preflight-ok");
  const chunkDir = path.join(outDir, "runtime", ".next", "server", "chunks");
  fs.mkdirSync(chunkDir, { recursive: true });
  fs.writeFileSync(
    path.join(chunkDir, "root.js"),
    `let x=await e.y("@libsql/client-7664182d7c51b711/web");`,
    "utf8",
  );
  // Materialize the alias package (the recursive scoped-alias fix would do this).
  const aliasDir = path.join(
    outDir, "runtime", "node_modules", "@libsql", "client-7664182d7c51b711",
  );
  fs.mkdirSync(path.join(aliasDir, "lib-esm"), { recursive: true });
  writeJson(path.join(aliasDir, "package.json"), { name: "@libsql/client" });
  fs.writeFileSync(path.join(aliasDir, "lib-esm", "web.js"), "export const web=1;", "utf8");

  const { refs, unresolved } = checkExternalAliasPreflight(outDir);
  assert.equal(refs.length, 1);
  assert.equal(unresolved.length, 0, "materialized alias must not be flagged");
});

test("preflight ignores ordinary (non-hashed) external specifiers", () => {
  const outDir = tempDir("preflight-ordinary");
  const chunkDir = path.join(outDir, "runtime", ".next", "server", "chunks");
  fs.mkdirSync(chunkDir, { recursive: true });
  fs.writeFileSync(
    path.join(chunkDir, "root.js"),
    [
      `e.x("next/dist/compiled/@vercel/og/index.node.js",()=>1);`,
      `require("node:fs");`,
      `e.y("react");`,
      // UUID / styled-jsx-like hashes in content must not false-positive.
      `const id="9188040d-6c67-4c5b-b112-36a304b66dad";`,
    ].join("\n"),
    "utf8",
  );
  const { unresolved } = checkExternalAliasPreflight(outDir);
  assert.equal(unresolved.length, 0, "ordinary specifiers must not be flagged");
});
