import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { bundleAppHandler } from "../dist/bundler.js";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `brrrd-adapter-${name}-`));
}

function res() {
  return {
    body: "",
    ended: false,
    statusCode: 200,
    end(chunk = "") {
      this.body = String(chunk);
      this.ended = true;
    },
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
  };
}

test("dispatcher resolves async webpack route module exports before calling handler", async () => {
  const root = tempDir("dispatcher");
  const syncRoute = path.join(root, "sync-route.mjs");
  const asyncRoute = path.join(root, "async-route.cjs");

  fs.writeFileSync(
    syncRoute,
    "export function handler(_req, res) { res.end('sync'); }\n",
    "utf8",
  );
  fs.writeFileSync(
    asyncRoute,
    "module.exports = Promise.resolve({ handler(_req, res) { res.end('async'); } });\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [
      { id: "sync", filePath: syncRoute },
      { id: "async", filePath: asyncRoute },
    ],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));

  const syncRes = res();
  await dispatch("sync", { headers: { host: "example.test" } }, syncRes);
  assert.equal(syncRes.body, "sync");

  const asyncRes = res();
  await dispatch("async", { headers: { host: "example.test" } }, asyncRes);
  assert.equal(asyncRes.body, "async");
});

test("dispatcher loads only the requested route module", async () => {
  const root = tempDir("dispatcher-lazy-route");
  const healthyRoute = path.join(root, "healthy-route.mjs");
  const brokenRoute = path.join(root, "broken-route.mjs");

  fs.writeFileSync(
    healthyRoute,
    "export function handler(_req, res) { res.end('healthy'); }\n",
    "utf8",
  );
  fs.writeFileSync(
    brokenRoute,
    "throw new ReferenceError('self is not defined');\nexport function handler() {}\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [
      { id: "healthy", filePath: healthyRoute },
      { id: "broken", filePath: brokenRoute },
    ],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));

  const healthyRes = res();
  await dispatch("healthy", { headers: { host: "example.test" } }, healthyRes);
  assert.equal(healthyRes.body, "healthy");

  await assert.rejects(
    dispatch("broken", { headers: { host: "example.test" } }, res()),
    /self is not defined/,
  );
});

test("dispatcher bundling tolerates missing Next optional runtime dependencies", async () => {
  const root = tempDir("dispatcher-optional-runtime-dep");
  const healthyRoute = path.join(root, "healthy-route.mjs");
  const optionalRoute = path.join(root, "optional-route.cjs");

  fs.writeFileSync(
    healthyRoute,
    "export function handler(_req, res) { res.end('healthy'); }\n",
    "utf8",
  );
  fs.writeFileSync(
    optionalRoute,
    "const critters = require('critters');\nmodule.exports = { handler(_req, res) { res.end(String(critters)); } };\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [
      { id: "healthy", filePath: healthyRoute },
      { id: "optional", filePath: optionalRoute },
    ],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));

  const healthyRes = res();
  await dispatch("healthy", { headers: { host: "example.test" } }, healthyRes);
  assert.equal(healthyRes.body, "healthy");

  await assert.rejects(
    dispatch("optional", { headers: { host: "example.test" } }, res()),
    (err) => {
      assert.match(err.message, /Cannot find module 'critters'/);
      assert.equal(err.code, "MODULE_NOT_FOUND");
      return true;
    },
  );
});

test("dispatcher loads packaged CommonJS runtime chunk files", async () => {
  const root = tempDir("dispatcher-runtime-file-require");
  const distDir = path.join(root, ".next");
  const route = path.join(root, "route.cjs");
  const chunk = path.join(distDir, "server", "chunks", "ssr", "external.js");
  const nodeExternal = path.join(
    root,
    "node_modules",
    "next",
    "dist",
    "compiled",
    "next-server",
    "pages-turbo.runtime.prod.js",
  );
  const packageMainDir = path.join(
    root,
    "node_modules",
    "next",
    "dist",
    "compiled",
    "source-map",
  );
  const swcHelpersRoot = path.join(root, "node_modules", "@swc", "helpers");
  fs.mkdirSync(path.dirname(chunk), { recursive: true });
  fs.mkdirSync(path.dirname(nodeExternal), { recursive: true });
  fs.mkdirSync(packageMainDir, { recursive: true });
  fs.mkdirSync(path.join(swcHelpersRoot, "cjs"), { recursive: true });
  fs.writeFileSync(chunk, "module.exports = { answer: 'chunk-ok' };\n", "utf8");
  fs.writeFileSync(
    nodeExternal,
    "const packageMain = require('next/dist/compiled/source-map');\nconst helper = require('@swc/helpers/_/_interop_require_default');\nmodule.exports = { runtime: 'pages-turbo', packageMain: packageMain.packageMain, helper: helper._() };\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(packageMainDir, "package.json"),
    JSON.stringify({ main: "source-map.js" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(packageMainDir, "source-map.js"),
    "module.exports = { packageMain: 'source-map-ok' };\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(swcHelpersRoot, "package.json"),
    JSON.stringify({
      name: "@swc/helpers",
      exports: {
        "./_/_interop_require_default": {
          import: "./esm/_interop_require_default.js",
          default: "./cjs/_interop_require_default.cjs",
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(swcHelpersRoot, "cjs", "_interop_require_default.cjs"),
    "exports._ = function interop() { return 'swc-helper-ok'; };\n",
    "utf8",
  );
  fs.writeFileSync(
    route,
    `
const path = require('path');

module.exports = {
  handler(_req, res) {
    const chunk = require(path.join(
      globalThis.__brrrd_turbopack_runtime_root,
      'server/chunks/ssr/external.js'
    ));
    const external = require(globalThis.__brrrd_external_runtime_spec);
    res.end(chunk.answer + ':' + external.runtime + ':' + external.packageMain + ':' + external.helper);
  },
};
`,
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [{ id: "runtime-file", filePath: route }],
    {
      projectDir: root,
      distDir,
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const previousModules = globalThis.__brrrd_modules;
  const previousRuntimeRoot = globalThis.__brrrd_turbopack_runtime_root;
  const previousNodeModulesRoot = globalThis.__brrrd_node_modules_root;
  const previousExternalRuntimeSpec = globalThis.__brrrd_external_runtime_spec;
  globalThis.__brrrd_modules = { fs, path };
  globalThis.__brrrd_turbopack_runtime_root = distDir;
  globalThis.__brrrd_node_modules_root = path.join(root, "node_modules");
  globalThis.__brrrd_external_runtime_spec =
    "next/dist/compiled/next-server/pages-turbo.runtime.prod.js";
  try {
    const { default: dispatch } = await import(pathToFileURL(bundlePath));
    const runtimeFileRes = res();
    await dispatch("runtime-file", { headers: { host: "example.test" } }, runtimeFileRes);
    assert.equal(runtimeFileRes.body, "chunk-ok:pages-turbo:source-map-ok:swc-helper-ok");
  } finally {
    if (previousModules === undefined) {
      delete globalThis.__brrrd_modules;
    } else {
      globalThis.__brrrd_modules = previousModules;
    }
    if (previousRuntimeRoot === undefined) {
      delete globalThis.__brrrd_turbopack_runtime_root;
    } else {
      globalThis.__brrrd_turbopack_runtime_root = previousRuntimeRoot;
    }
    if (previousNodeModulesRoot === undefined) {
      delete globalThis.__brrrd_node_modules_root;
    } else {
      globalThis.__brrrd_node_modules_root = previousNodeModulesRoot;
    }
    if (previousExternalRuntimeSpec === undefined) {
      delete globalThis.__brrrd_external_runtime_spec;
    } else {
      globalThis.__brrrd_external_runtime_spec = previousExternalRuntimeSpec;
    }
  }
});

test("dispatcher supplies Next-compatible no-op OpenTelemetry API", async () => {
  const root = tempDir("dispatcher-otel");
  const otelRoute = path.join(root, "otel-route.cjs");

  fs.writeFileSync(
    otelRoute,
    `
const { trace, context } = require('@opentelemetry/api');

module.exports = {
  handler(_req, res) {
    const provider = trace.getTracerProvider();
    const tracer = provider.getTracer('next.js', '0.0.1');
    const result = tracer.startActiveSpan('render', {}, context.active(), (span) => {
      span.setAttribute('next.span_name', 'render');
      return 'otel-ok';
    });
    res.end(result);
  },
};
`,
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [{ id: "otel", filePath: otelRoute }],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));

  const otelRes = res();
  await dispatch("otel", { headers: { host: "example.test" } }, otelRes);
  assert.equal(otelRes.body, "otel-ok");
});
