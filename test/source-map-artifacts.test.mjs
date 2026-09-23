import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createArtifactPlan,
  executeArtifactPlan,
  manifestArtifacts,
} from "../dist/artifact-planner.js";
import { createNextBuildModel } from "../dist/model.js";

const sourceMap = JSON.stringify({
  version: 3, sources: ["input.ts"], names: [], mappings: "AAAA",
  sourcesContent: ["export const value = 1;"],
});
const emptySupplement = {
  staticResponseMeta: [], dynamicPrerenderRoutes: [], appPrerenderDataRoutes: [],
  pprSegmentPrefetchRoutes: [], staticRouteSupplement: [], pprPages: [],
};

function fixture(t, distName = ".next") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-source-map-artifacts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const distDir = path.join(root, distName);
  const outDir = path.join(root, "dist", "brrrd");
  const handler = path.join(distDir, "server", "app", "page.js");
  const write = (file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  };
  write(handler, "module.exports = {};\n");
  const output = { id: "/", pathname: "/", filePath: handler, assets: {} };
  const context = {
    projectDir: root, repoRoot: root, distDir, config: {},
    nextVersion: "16.2.7", buildId: "test-build",
    outputs: {
      pages: [], appPages: [output], appRoutes: [], pagesApi: [],
      prerenders: [], staticFiles: [],
    },
  };
  const plan = () => createArtifactPlan(
    createNextBuildModel(context), emptySupplement, new Map(), outDir,
    { hasAppBundle: false },
  );
  return { root, distDir, outDir, handler, output, context, write, plan };
}

for (const distName of [".next", ".custom-next-output"]) {
  test(`omits generated server maps from traces and both chunk locations (${distName})`, (t) => {
    const f = fixture(t, distName);
    const chunk = f.write(
      path.join(f.distDir, "server", "chunks", "ssr", "untraced.js"),
      "module.exports = { value: 'runtime chunk' };\n",
    );
    const chunkMap = f.write(`${chunk}.map`, sourceMap);
    const indexedChunk = f.write(
      path.join(f.distDir, "server", "chunks", "ssr", "indexed.mjs"),
      "export const value = 1;\n",
    );
    const indexedMap = f.write(`${indexedChunk}.map`, JSON.stringify({
      version: 3, sections: [{ offset: { line: 0, column: 0 }, map: JSON.parse(sourceMap) }],
    }));
    const assetMap = f.write(`${f.handler}.map`, sourceMap);
    f.output.assets = { "server/app/page.js.map": assetMap };
    const tracedScript = f.write(
      path.join(f.distDir, "server", "pages", "404.cjs"),
      "module.exports = {};\n",
    );
    const tracedMap = f.write(`${tracedScript}.map`, sourceMap);
    f.write(`${f.handler}.nft.json`, JSON.stringify({
      version: 1,
      files: [tracedScript, tracedMap].map((file) => path.relative(path.dirname(f.handler), file)),
    }));

    const plan = f.plan();
    executeArtifactPlan(plan, f.outDir);
    const artifacts = manifestArtifacts(plan);
    assert.deepEqual(artifacts.filter((item) => item.packagePath.endsWith(".map")), []);
    for (const original of [chunkMap, indexedMap, assetMap, tracedMap]) {
      assert.equal(fs.existsSync(original), true, "local build maps remain available");
      const rel = path.relative(f.distDir, original);
      assert.equal(fs.existsSync(path.join(f.outDir, "runtime", ".next", rel)), false);
    }
    for (const rel of ["ssr/untraced.js.map", "ssr/indexed.mjs.map"]) {
      assert.equal(fs.existsSync(path.join(f.outDir, "runtime", "chunks", rel)), false);
    }
    for (const script of [chunk, indexedChunk]) {
      const chunkRel = path.relative(path.join(f.distDir, "server", "chunks"), script);
      const expected = fs.readFileSync(script, "utf8");
      for (const prefix of ["runtime/.next/server/chunks", "runtime/chunks"]) {
        const packagePath = `${prefix}/${chunkRel}`;
        assert.equal(fs.readFileSync(path.join(f.outDir, packagePath), "utf8"), expected);
        assert.equal(artifacts.filter((item) => item.packagePath === packagePath).length, 1);
      }
    }
    assert.equal(
      fs.readFileSync(path.join(f.outDir, "runtime/.next/server/pages/404.cjs"), "utf8"),
      "module.exports = {};\n",
    );
  });
}

test("preserves application map data, external maps, and public/browser maps", (t) => {
  const f = fixture(t);
  const expected = new Map();
  const dataFiles = [
    ["server/chunks/data.map", "application map data"],
    ["server/chunks/data.js.map", JSON.stringify({ version: 3, lookup: { code: "US" } })],
    ["server/chunks/malformed.js.map", "{not source-map JSON}"],
    ["server/chunks/orphan.js.map", sourceMap],
    ["server-other/chunks/outside.js.map", sourceMap],
  ];
  for (const [rel, contents] of dataFiles) {
    const file = f.write(path.join(f.distDir, rel), contents);
    if (rel.endsWith(".js.map") && !rel.includes("orphan")) {
      f.write(file.slice(0, -4), "module.exports = {};\n");
    }
    f.output.assets[rel] = file;
    expected.set(`runtime/.next/${rel}`, contents);
    if (rel.startsWith("server/chunks/")) {
      expected.set(`runtime/chunks/${rel.slice("server/chunks/".length)}`, contents);
    }
  }

  for (const rel of ["assets/lookup.js.map", "node_modules/test-package/index.js.map"]) {
    const file = f.write(path.join(f.root, rel), sourceMap);
    f.write(file.slice(0, -4), "module.exports = {};\n");
    f.output.assets[rel] = file;
    expected.set(`runtime/${rel}`, sourceMap);
  }
  for (const [rel, pathname, contents] of [
    ["public/app.js.map", "/app.js.map", sourceMap],
    [".next/static/chunks/client.js.map", "/_next/static/chunks/client.js.map", sourceMap],
  ]) {
    const file = f.write(path.join(f.root, rel), contents);
    f.write(file.slice(0, -4), "console.log('client');\n");
    f.context.outputs.staticFiles.push({ id: pathname, pathname, filePath: file });
    expected.set(`static${pathname}`, contents);
  }

  const plan = f.plan();
  executeArtifactPlan(plan, f.outDir);
  const artifacts = manifestArtifacts(plan);
  for (const [packagePath, contents] of expected) {
    assert.equal(fs.readFileSync(path.join(f.outDir, packagePath), "utf8"), contents);
    assert.equal(artifacts.filter((item) => item.packagePath === packagePath).length, 1);
  }
});

test("does not classify a symlink to an application map as generated server output", (t) => {
  const f = fixture(t);
  const appMap = f.write(path.join(f.root, "assets", "data.js.map"), sourceMap);
  const serverScript = f.write(
    path.join(f.distDir, "server", "app", "data.js"),
    "module.exports = {};\n",
  );
  const linkedMap = `${serverScript}.map`;
  fs.symlinkSync(appMap, linkedMap);
  f.output.assets["server/app/data.js.map"] = linkedMap;

  const plan = f.plan();
  executeArtifactPlan(plan, f.outDir);
  assert.equal(
    fs.readFileSync(path.join(f.outDir, "runtime/.next/server/app/data.js.map"), "utf8"),
    sourceMap,
  );
});
