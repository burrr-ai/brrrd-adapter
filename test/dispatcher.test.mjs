import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { beforeEach } from "node:test";

import { bundleAppHandler } from "../dist/bundler.js";

// Unit tests declare the same ABI a native runtime provides as a reserved binding.
process.env.BRRRD_RUNTIME_ABI = "workerd-node-v1";

// Each case is a different product isolate. Production rejects mixed bundle owners.
beforeEach(() => {
  for (const key of ['@next/cache-handlers', '@next/cache-handlers-map', '@next/cache-handlers-set']) {
    delete globalThis[Symbol.for(key)];
  }
});

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

test("dispatcher inlines Next server build-time env from resolved config", async () => {
  const root = tempDir("dispatcher-next-server-env");
  const route = path.join(root, "route.mjs");

  fs.writeFileSync(
    route,
    [
      "export function handler(_req, res) {",
      "  res.end(JSON.stringify({",
      "    nodeEnv: process.env.NODE_ENV,",
      "    runtime: process.env.NEXT_RUNTIME,",
      "    ppr: process.env.__NEXT_PPR,",
      "    cacheComponents: process.env.__NEXT_CACHE_COMPONENTS,",
      "    cachedNavigations: process.env.__NEXT_EXPERIMENTAL_CACHED_NAVIGATIONS,",
      "    instantNav: process.env.__NEXT_INSTANT_NAV_TOGGLE,",
      "    useCache: process.env.__NEXT_USE_CACHE,",
      "    nodeStreams: process.env.__NEXT_USE_NODE_STREAMS,",
      "    appShells: process.env.__NEXT_APP_SHELLS,",
      "    varyParams: process.env.__NEXT_VARY_PARAMS,",
      "    cacheLife: process.env.__NEXT_CACHE_LIFE,",
      "  }));",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [{ id: "env", filePath: route }],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
      config: {
        cacheComponents: true,
        cacheLife: { seconds: { stale: 30, revalidate: 1, expire: 60 } },
        experimental: {
          appShells: true,
          cachedNavigations: true,
          optimisticRouting: true,
          ppr: true,
          useCache: true,
          varyParams: true,
        },
      },
    },
  );

  const bundle = fs.readFileSync(bundlePath, "utf8");
  assert.equal(bundle.includes("process.env.__NEXT_CACHE_COMPONENTS"), false);
  assert.equal(bundle.includes("process.env.__NEXT_APP_SHELLS"), false);
  assert.equal(bundle.includes("process.env.__NEXT_VARY_PARAMS"), false);

  const { default: dispatch } = await import(pathToFileURL(bundlePath));
  const envRes = res();
  await dispatch("env", { headers: { host: "example.test" } }, envRes);

  assert.deepEqual(JSON.parse(envRes.body), {
    nodeEnv: "production",
    runtime: "nodejs",
    ppr: true,
    cacheComponents: true,
    cachedNavigations: true,
    instantNav: true,
    useCache: true,
    nodeStreams: true,
    appShells: true,
    varyParams: true,
    cacheLife: { seconds: { stale: 30, revalidate: 1, expire: 60 } },
  });
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
      __brrrd_request_meta: { preserved: "yes", distDir: "/bundle/runtime/.next" },
    },
    metaRes,
  );

  assert.deepEqual(JSON.parse(metaRes.body), {
    preserved: "yes",
    relativeProjectDir: ".",
    distDir: "/bundle/runtime/.next",
    hostname: "example.test",
    minimalMode: false,
  });
});

test("dispatcher preserves brrrd PPR resume metadata for Next route modules", async () => {
  const root = tempDir("dispatcher-ppr-resume-meta");
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
      __brrrd_request_meta: {
        minimalMode: true,
        postponed: "postponed-state",
        distDir: "/bundle/runtime/.next",
      },
    },
    metaRes,
  );

  assert.deepEqual(JSON.parse(metaRes.body), {
    minimalMode: true,
    postponed: "postponed-state",
    relativeProjectDir: ".",
    distDir: "/bundle/runtime/.next",
    hostname: "example.test",
  });
});

test("dispatcher keeps brrrd PPR fallback route params out of Next request metadata", async () => {
  const root = tempDir("dispatcher-ppr-fallback-wire");
  const route = path.join(root, "route.mjs");

  fs.writeFileSync(
    route,
    `export function handler(_req, res, ctx) {
      const fallbackParams = ctx.requestMeta.fallbackParams;
      res.end(JSON.stringify({
        hasCompilerWireField: Object.prototype.hasOwnProperty.call(ctx.requestMeta, 'pprFallbackRouteParams'),
        hasFallbackParams: Object.prototype.hasOwnProperty.call(ctx.requestMeta, 'fallbackParams'),
        isMap: fallbackParams instanceof Map,
        entries: fallbackParams ? Array.from(fallbackParams.entries()) : [],
      }));
    }\n`,
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
      __brrrd_request_meta: {
        pprFallbackRouteParams: [
          { paramName: "teamSlug", paramType: "dynamic" },
          { paramName: "rest", paramType: "catchall" },
        ],
      },
    },
    metaRes,
  );

  const body = JSON.parse(metaRes.body);
  assert.equal(body.hasCompilerWireField, false);
  assert.equal(body.hasFallbackParams, false);
  assert.equal(body.isMap, false);
  assert.deepEqual(body.entries, []);
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

test("dispatcher renders custom Pages 500 route when a Pages handler throws", async () => {
  const root = tempDir("dispatcher-render500");
  const throwingRoute = path.join(root, "throwing-route.mjs");
  const statusRoute = path.join(root, "500-route.mjs");
  const errorRoute = path.join(root, "error-route.mjs");

  fs.writeFileSync(
    throwingRoute,
    "export async function handler() { const err = new Error('oof'); err.code = 'ENOENT'; throw err; }\n",
    "utf8",
  );
  fs.writeFileSync(
    statusRoute,
    "export function handler(req, res, ctx) { res.end('500:' + res.statusCode + ':' + ctx.requestMeta.invokeError.message + ':' + req.sideEffect); }\n",
    "utf8",
  );
  fs.writeFileSync(
    errorRoute,
    "export function handler(req, res, ctx) { req.sideEffect = ctx.requestMeta.customErrorRender ? 'reported' : 'missing'; }\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [
      { id: "enoent", filePath: throwingRoute },
      { id: "500", filePath: statusRoute },
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

  const errorRes = res();
  await dispatch(
    "enoent",
    { url: "/enoent", headers: { host: "example.test" } },
    errorRes,
  );

  assert.equal(errorRes.statusCode, 500);
  assert.equal(errorRes.body, "500:500:oof:reported");
});

test("dispatcher wires Next router-server revalidate metadata to brrrd path invalidation", async () => {
  const root = tempDir("dispatcher-revalidate");
  const apiRoute = path.join(root, "api-route.mjs");

  fs.writeFileSync(
    apiRoute,
    "export async function handler(_req, res, ctx) { await ctx.requestMeta.revalidate({ urlPath: '/stale' }); res.end('ok'); }\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [{ id: "api-revalidate", filePath: apiRoute }],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const invalidated = [];
  const { default: dispatch } = await import(pathToFileURL(bundlePath));
  const apiRes = res();
  await dispatch("api-revalidate", {
    headers: { host: "example.test" },
    cloudflare: { env: { BRRRD_CACHE: { async fetch(_url, init) {
      assert.equal(init.method, "POST");
      assert.ok(init.body instanceof Uint8Array);
      const length = new DataView(init.body.buffer, init.body.byteOffset, 4).getUint32(0, false);
      assert.equal(length + 4, init.body.byteLength);
      const operation = JSON.parse(new TextDecoder().decode(init.body.subarray(4)));
      assert.equal(operation.op, "revalidate_path");
      invalidated.push(operation.key);
      return Response.json(true);
    } } } },
  }, apiRes);
  assert.equal(apiRes.body, "ok");
  assert.deepEqual(invalidated, ["/stale"]);
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

test("dispatcher resolves package main paths through global require.resolve", async () => {
  const root = tempDir("dispatcher-runtime-require-resolve");
  const route = path.join(root, "route.cjs");
  const packageDir = path.join(root, "node_modules", "typescript");
  const packageMain = path.join(packageDir, "lib", "typescript.js");

  fs.mkdirSync(path.dirname(packageMain), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "typescript", main: "./lib/typescript.js" }),
    "utf8",
  );
  fs.writeFileSync(packageMain, "module.exports = { marker: 'ts-runtime' };\n", "utf8");
  fs.writeFileSync(
    route,
    `
const path = require('path');

module.exports = {
  handler(_req, res) {
    const resolved = require.resolve('typescript');
    res.end(path.basename(resolved) + ':' + require('typescript').marker);
  },
};
`,
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [{ id: "runtime-require-resolve", filePath: route }],
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
    const runtimeFileRes = res();
    await dispatch("runtime-require-resolve", { headers: { host: "example.test" } }, runtimeFileRes);
    assert.equal(runtimeFileRes.body, "typescript.js:ts-runtime");
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

test("dispatcher bundles the actual Next OpenTelemetry API with its default no-op provider", async () => {
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

test("dispatcher prefers the app OpenTelemetry API over the Next vendored API", async () => {
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
exports.createContextKey = (name) => Symbol.for(name);
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

test('dispatcher selects one modern writer and the canonical external legacy class', async () => {
  const root = tempDir('dispatcher-cache-writer');
  const route = path.join(root, 'route.mjs');
  fs.writeFileSync(route, "export function handler(_req,res){res.end('ok');}\n");
  const outDir = path.join(root, 'out');
  const file = await bundleAppHandler([{id:'route',filePath:route}], {projectDir:root,distDir:path.join(root,'.next'),outDir,buildId:'writers'});
  const {default:dispatch} = await import(pathToFileURL(file));
  await dispatch('route', {headers:{host:'example.test'}}, res());
  const runtime = path.join(outDir,'runtime/node_modules/.cache/@brrrd/adapter');
  const modern = (await import(pathToFileURL(path.join(runtime,'cache-handler.mjs')))).default;
  const legacy = (await import(pathToFileURL(path.join(runtime,'cache-handler-legacy.mjs')))).default;
  const entries = globalThis[Symbol.for('@next/cache-handlers-map')];
  assert.deepEqual([...entries.keys()].sort(), ['default','remote']);
  assert.equal(entries.get('default'),modern);assert.equal(entries.get('remote'),modern);
  assert.deepEqual([...globalThis[Symbol.for('@next/cache-handlers-set')]], [modern]);
  assert.equal(globalThis[Symbol.for('@next/cache-handlers')].FetchCache,legacy);
});

test('two bundles in one global are explicitly rejected without replacing the first writer', async () => {
  const root = tempDir('dispatcher-competing-cache-writer');
  const route=path.join(root,'route.mjs');fs.writeFileSync(route,"export function handler(_req,res){res.end('ok');}\n");
  const builds=[];
  for(const id of ['one','two'])builds.push(await bundleAppHandler([{id:'route',filePath:route}],{projectDir:root,distDir:path.join(root,'.next'),outDir:path.join(root,id),buildId:id}));
  const first=(await import(pathToFileURL(builds[0]))).default, second=(await import(pathToFileURL(builds[1]))).default;
  await first('route',{headers:{host:'example.test'}},res());
  const writer=globalThis[Symbol.for('@next/cache-handlers')].DefaultCache;
  await assert.rejects(second('route',{headers:{host:'example.test'}},res()),/unsupported competing Next cache handler/);
  assert.equal(globalThis[Symbol.for('@next/cache-handlers')].DefaultCache,writer);
  const response=res();await first('route',{headers:{host:'example.test'}},response);assert.equal(response.body,'ok');
});

test('artifact initializer imports real routes without fabricating a request event', async () => {
  const root=tempDir('dispatcher-native-initialize');
  const route=path.join(root,'route.mjs');
  fs.writeFileSync(route,"globalThis.__brrrdInitializerImported = true; export function handler(_req,res){res.end('ok');}\n");
  delete globalThis.__brrrdInitializerImported;
  const file=await bundleAppHandler([{id:'route',filePath:route}],{projectDir:root,distDir:path.join(root,'.next'),outDir:path.join(root,'out'),buildId:'initialize'});
  const app=await import(pathToFileURL(file));assert.equal(globalThis.__brrrdInitializerImported,undefined);
  await app.initialize();assert.equal(globalThis.__brrrdInitializerImported,true);
  delete globalThis.__brrrdInitializerImported;
});

test('artifact initializer rejects an actual route import failure before invocation', async () => {
  const root=tempDir('dispatcher-native-initialize-error');
  const route=path.join(root,'route.mjs');
  fs.writeFileSync(route,"throw new Error('actual-route-initialization-refused'); export function handler(){ throw new Error('must not invoke'); }\n");
  const file=await bundleAppHandler([{id:'route',filePath:route}],{projectDir:root,distDir:path.join(root,'.next'),outDir:path.join(root,'out'),buildId:'initialize-error'});
  const app=await import(pathToFileURL(file));
  await assert.rejects(app.initialize(),/actual-route-initialization-refused/);
});

test('dispatcher loads official Next baseline before actual AsyncLocalStorage capture', async () => {
  const root=tempDir('dispatcher-next-als-baseline');const route=path.join(root,'route.mjs');
  const alsModule=path.join(import.meta.dirname,'../node_modules/next/dist/server/app-render/work-async-storage.external.js');
  fs.writeFileSync(route,`import { workAsyncStorage } from ${JSON.stringify(alsModule)}; export function handler(_req,res){workAsyncStorage.run({nativeBaseline:true},()=>res.end(JSON.stringify(workAsyncStorage.getStore()))); }\n`);
  const file=await bundleAppHandler([{id:'als',filePath:route}],{projectDir:root,distDir:path.join(root,'.next'),outDir:path.join(root,'out'),buildId:'als'});
  const before=globalThis.AsyncLocalStorage;delete globalThis.AsyncLocalStorage;
  try {
    const app=await import(pathToFileURL(file));const response=res();await app.default('als',{headers:{host:'example.test'}},response);
    assert.deepEqual(JSON.parse(response.body),{nativeBaseline:true});
    assert.equal(globalThis.AsyncLocalStorage,(await import('node:async_hooks')).AsyncLocalStorage);
  } finally { if(before===undefined)delete globalThis.AsyncLocalStorage;else globalThis.AsyncLocalStorage=before; }
});

test("Node proxy uses the generated Web handler and keeps its default adapter ABI separate", async () => {
  const root = tempDir("node-proxy-web-handler");
  const route = path.join(root, "route.mjs");
  const proxyModule = path.join(root, "proxy.mjs");
  fs.writeFileSync(route, "export function handler(_req,res) { res.end('route'); }\n");
  fs.writeFileSync(proxyModule, `
    export default function adapterOptions() { throw new Error('wrong default ABI'); }
    export async function handler(request, ctx) {
      ctx.waitUntil(Promise.resolve());
      return new Response(request.method + ':' + await request.text(), {headers: {'x-official-handler':'web'}});
    }
  `);
  const bundle = await bundleAppHandler([{id:'route',filePath:route}], {
    projectDir:root,distDir:path.join(root,'.next'),outDir:path.join(root,'out'),buildId:'proxy-test',
  }, {filePath:proxyModule});
  const app = await import(pathToFileURL(bundle));
  await app.initialize();
  const background = [];
  const response = await app.proxy(new Request('http://proxy.test/body', {method:'POST',body:'actual-body'}), {}, {waitUntil(p) {background.push(p);}}, {});
  assert.equal(await response.text(),'POST:actual-body');
  assert.equal(response.headers.get('x-official-handler'),'web');
  await Promise.all(background);
  fs.rmSync(root,{recursive:true,force:true});
});
