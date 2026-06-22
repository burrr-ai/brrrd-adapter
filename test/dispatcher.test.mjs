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

test("dispatcher provides Next virtual project and dist request metadata", async () => {
  const root = tempDir("dispatcher-next-request-meta");
  const route = path.join(root, "route.mjs");

  fs.writeFileSync(
    route,
    "export function handler(_req, res, ctx) { res.end(JSON.stringify(ctx.requestMeta)); }\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [{ id: "meta", filePath: route }],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));

  const metaRes = res();
  await dispatch(
    "meta",
    {
      headers: { host: "example.test" },
      __brrrd_request_meta: { preserved: "yes" },
    },
    metaRes,
  );

  assert.deepEqual(JSON.parse(metaRes.body), {
    preserved: "yes",
    relativeProjectDir: ".",
    distDir: "/bundle/.next",
    hostname: "example.test",
    minimalMode: true,
  });
});

test("dispatcher provides render404 request metadata for Next Pages notFound handling", async () => {
  const root = tempDir("dispatcher-render404");
  const dynamicRoute = path.join(root, "dynamic-route.mjs");
  const errorRoute = path.join(root, "error-route.mjs");

  fs.writeFileSync(
    dynamicRoute,
    "export async function handler(req, res, ctx) { await ctx.requestMeta.render404(req, res); }\n",
    "utf8",
  );
  fs.writeFileSync(
    errorRoute,
    "export function handler(req, res) { res.end('error:' + res.statusCode + ':' + req.url); }\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [
      { id: "_slug_", filePath: dynamicRoute },
      { id: "_error", filePath: errorRoute },
    ],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));

  const notFoundRes = res();
  await dispatch(
    "_slug_",
    { url: "/3", headers: { host: "example.test" } },
    notFoundRes,
  );

  assert.equal(notFoundRes.body, "error:404:/3");
});

test("dispatcher bundling tolerates missing package requires from Next runtime files", async () => {
  const root = tempDir("dispatcher-optional-runtime-dep");
  const healthyRoute = path.join(root, "healthy-route.mjs");
  const optionalRoute = path.join(root, "optional-route.cjs");
  const nextRuntime = path.join(
    root,
    "node_modules",
    "next",
    "dist",
    "compiled",
    "next-server",
    "pages.runtime.prod.js",
  );

  fs.writeFileSync(
    healthyRoute,
    "export function handler(_req, res) { res.end('healthy'); }\n",
    "utf8",
  );
  fs.mkdirSync(path.dirname(nextRuntime), { recursive: true });
  fs.writeFileSync(
    nextRuntime,
    "exports.loadOptionalCssOptimizer = function() { return require('critters'); };\n",
    "utf8",
  );
  fs.writeFileSync(
    optionalRoute,
    "const runtime = require('next/dist/compiled/next-server/pages.runtime.prod.js');\nmodule.exports = { handler(_req, res) { res.end(String(runtime.loadOptionalCssOptimizer())); } };\n",
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

test("dispatcher bundling leaves missing late imports inside node_modules for runtime resolution", async () => {
  const root = tempDir("dispatcher-node-modules-late-runtime-dep");
  const route = path.join(root, "route.mjs");
  const esmPackage = path.join(root, "node_modules", "esm-dead-branch");
  const cjsPackage = path.join(root, "node_modules", "cjs-dead-branch");

  fs.mkdirSync(esmPackage, { recursive: true });
  fs.mkdirSync(cjsPackage, { recursive: true });
  fs.writeFileSync(
    path.join(esmPackage, "package.json"),
    JSON.stringify({
      name: "esm-dead-branch",
      exports: { "./entry": { import: "./entry.mjs" } },
      type: "module",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(esmPackage, "entry.mjs"),
    "if (Math.random() < 0) import('missing-esm-late-dep');\nexport const value = 'esm-ok';\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(cjsPackage, "package.json"),
    JSON.stringify({
      name: "cjs-dead-branch",
      exports: { "./entry": { require: "./entry.cjs", import: "./entry.cjs" } },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cjsPackage, "entry.cjs"),
    "if (Math.random() < 0) require('missing-cjs-late-dep');\nexports.value = 'cjs-ok';\n",
    "utf8",
  );
  fs.writeFileSync(
    route,
    "import { value as esmValue } from 'esm-dead-branch/entry';\nimport cjs from 'cjs-dead-branch/entry';\nexport function handler(_req, res) { res.end(esmValue + ':' + cjs.value); }\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [{ id: "late-dep", filePath: route }],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));
  const lateDepRes = res();
  await dispatch("late-dep", { headers: { host: "example.test" } }, lateDepRes);
  assert.equal(lateDepRes.body, "esm-ok:cjs-ok");
});

test("dispatcher bundling preserves require conditions for Next Pages server bundles", async () => {
  const root = tempDir("dispatcher-pages-require-condition");
  const distDir = path.join(root, ".next");
  const route = path.join(distDir, "server", "pages", "ssr.js");
  const pkg = path.join(root, "node_modules", "invalid-server-package");

  fs.mkdirSync(path.dirname(route), { recursive: true });
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "invalid-server-package",
      exports: {
        "./entry": {
          browser: "./browser.js",
          import: "./correct.js",
          require: "./alternative.js",
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(pkg, "browser.js"), "module.exports = 'Browser';\n", "utf8");
  fs.writeFileSync(path.join(pkg, "correct.js"), "module.exports = 'World';\n", "utf8");
  fs.writeFileSync(path.join(pkg, "alternative.js"), "module.exports = 'Alternative';\n", "utf8");
  fs.writeFileSync(
    route,
    "const value = require('invalid-server-package/entry');\nmodule.exports = { handler(_req, res) { res.end(String(value.default ?? value)); } };\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [{ id: "ssr", filePath: route }],
    {
      projectDir: root,
      distDir,
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));
  const ssrRes = res();
  await dispatch("ssr", { headers: { host: "example.test" } }, ssrRes);
  assert.equal(ssrRes.body, "Alternative");
});

test("dispatcher bundling still fails direct app requires for missing packages", async () => {
  const root = tempDir("dispatcher-direct-missing-runtime-dep");
  const route = path.join(root, "route.cjs");

  fs.writeFileSync(
    route,
    "const missing = require('critters');\nmodule.exports = { handler(_req, res) { res.end(String(missing)); } };\n",
    "utf8",
  );

  await assert.rejects(
    bundleAppHandler(
      [{ id: "direct-missing", filePath: route }],
      {
        projectDir: root,
        distDir: path.join(root, ".next"),
        outDir: path.join(root, "out"),
        buildId: "test-build",
      },
    ),
    /Could not resolve "critters"/,
  );
});

test("dispatcher bundling handles wasm assets referenced by traced runtime chunks", async () => {
  const root = tempDir("dispatcher-wasm-runtime-asset");
  const distDir = path.join(root, ".next");
  const route = path.join(distDir, "server", "app", "worker", "page.js");
  const wasm = path.join(distDir, "server", "chunks", "static", "media", "add.wasm");

  fs.mkdirSync(path.dirname(route), { recursive: true });
  fs.mkdirSync(path.dirname(wasm), { recursive: true });
  fs.writeFileSync(wasm, Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  fs.writeFileSync(
    route,
    "const wasm = require('../../chunks/static/media/add.wasm');\nmodule.exports = { handler(_req, res) { res.end(String(wasm instanceof Uint8Array || wasm.default instanceof Uint8Array)); } };\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [{ id: "worker", filePath: route, assets: { wasm } }],
    {
      projectDir: root,
      distDir,
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));
  const wasmRes = res();
  await dispatch("worker", { headers: { host: "example.test" } }, wasmRes);
  assert.equal(wasmRes.body, "true");
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

test("dispatcher prefers packaged OpenTelemetry API over fallback stub", async () => {
  const root = tempDir("dispatcher-otel-real-package");
  const otelRoute = path.join(root, "otel-route.cjs");
  const packageDir = path.join(root, "node_modules", "@opentelemetry", "api");

  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@opentelemetry/api", main: "index.js" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(packageDir, "index.js"),
    `
exports.trace = {
  getTracerProvider() {
    return {
      marker: 'real-otel-api',
      getTracer() {
        return {
          startActiveSpan(_name, _options, _context, fn) {
            return fn({ spanContext: () => ({ spanId: '0000000000000042' }) });
          },
        };
      },
    };
  },
};
exports.context = { active() { return {}; } };
`,
    "utf8",
  );
  fs.writeFileSync(
    otelRoute,
    `
const { trace, context } = require('@opentelemetry/api');

module.exports = {
  handler(_req, res) {
    const provider = trace.getTracerProvider();
    const tracer = provider.getTracer('next.js', '0.0.1');
    const result = tracer.startActiveSpan('render', {}, context.active(), (span) => {
      return provider.marker + ':' + span.spanContext().spanId;
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

  const previousModules = globalThis.__brrrd_modules;
  const previousNodeModulesRoot = globalThis.__brrrd_node_modules_root;
  globalThis.__brrrd_modules = { fs, path };
  globalThis.__brrrd_node_modules_root = path.join(root, "node_modules");
  try {
    const { default: dispatch } = await import(pathToFileURL(bundlePath));
    const otelRes = res();
    await dispatch("otel", { headers: { host: "example.test" } }, otelRes);
    assert.equal(otelRes.body, "real-otel-api:0000000000000042");
  } finally {
    if (previousModules === undefined) {
      delete globalThis.__brrrd_modules;
    } else {
      globalThis.__brrrd_modules = previousModules;
    }
    if (previousNodeModulesRoot === undefined) {
      delete globalThis.__brrrd_node_modules_root;
    } else {
      globalThis.__brrrd_node_modules_root = previousNodeModulesRoot;
    }
  }
});
