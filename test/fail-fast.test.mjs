import assert from "node:assert/strict";
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { bundleAppHandler } from "../dist/bundler.js";
import { onBuildComplete } from "../dist/build.js";
import { writeManifest } from "../dist/manifest-emitter.js";
import { runtimeDependencyExternals } from "../dist/runtime-dependency-policy.js";
import {
  extractAppPrerenderDataRoutes,
  extractAppPrerenderResponseMeta,
  extractAppStaticResponseMeta,
  extractDynamicPrerenderRoutes,
  extractEdgeFunctions,
  extractMiddlewareMeta,
  extractPprSegmentPrefetchRoutes,
  extractRewriteSupplement,
  extractStaticRouteSupplement,
} from "../dist/manifest-supplement.js";
import { createNextBuildModel } from "../dist/model.js";
import { compileRouting } from "../dist/routing-compiler.js";

const require = createRequire(import.meta.url);

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `brrrd-adapter-${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

function symlinkDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.symlinkSync(src, dest, "dir");
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }
}

function writeFakeSharpPackage(root) {
  const dir = path.join(root, "node_modules", "sharp");
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "package.json"), {
    name: "sharp",
    version: "0.0.0-test",
    type: "module",
    main: "index.js",
  });
  fs.writeFileSync(path.join(dir, "index.js"), "export default function sharp() {}\n", "utf8");
}

function minimalContext(projectDir, distDir, output) {
  return {
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
      appPages: [output],
      appRoutes: [],
      pagesApi: [],
      prerenders: [],
      staticFiles: [],
    },
    projectDir,
    repoRoot: projectDir,
    distDir,
    config: {},
    nextVersion: "16.2.0",
    buildId: "test-build",
  };
}

test("onBuildComplete rejects native .node traced assets", async () => {
  const root = tempDir("native");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  fs.writeFileSync(handler, "export function handler() {}", "utf8");

  await assert.rejects(
    onBuildComplete(
      minimalContext(root, distDir, {
        id: "/",
        pathname: "/",
        filePath: handler,
        assets: { "native.node": path.join(root, "native.node") },
      }),
    ),
    /native Node addons/,
  );
});

test("runtime dependency policy externalizes terminal builtin probes", () => {
  const externals = new Set(runtimeDependencyExternals());
  assert.equal(externals.has("tty"), true);
  assert.equal(externals.has("node:tty"), true);
});

test("bundleAppHandler excludes server source maps from webpack dynamic chunk require contexts", async () => {
  const root = tempDir("server-source-map-context");
  const distDir = path.join(root, ".next");
  const outDir = path.join(root, "dist", "brrrd");
  const chunksDir = path.join(distDir, "server", "chunks");
  const runtimePath = path.join(distDir, "server", "webpack-runtime.js");
  const handlerPath = path.join(distDir, "server", "app", "page.js");

  fs.mkdirSync(chunksDir, { recursive: true });
  fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
  fs.writeFileSync(path.join(chunksDir, "224.js"), "module.exports = { ok: true };\n", "utf8");
  fs.writeFileSync(path.join(chunksDir, "224.js.map"), "{\"version\":3,\"sources\":[\"chunk.js\"]}\n", "utf8");
  fs.writeFileSync(
    runtimePath,
    `
const g = { u(id) { return id === 224 ? "224.js" : "224.js.map"; } };
module.exports = function loadChunk(id) {
  return require("./chunks/" + g.u(id));
};
`,
    "utf8",
  );
  fs.writeFileSync(
    handlerPath,
    `
const loadChunk = require("../webpack-runtime.js");
module.exports = function handler(req, res) {
  loadChunk(224);
  res.end("ok");
};
`,
    "utf8",
  );

  await bundleAppHandler(
    [{ id: "/", filePath: handlerPath, assets: {} }],
    { projectDir: root, distDir, outDir },
  );

  const bundlePath = path.join(outDir, "bundles", "app.js");
  assert.equal(fs.existsSync(bundlePath), true);
  assert.doesNotMatch(fs.readFileSync(bundlePath, "utf8"), /"sources":\["chunk\.js"\]/);
});

test("bundleAppHandler does not globally empty user-authored source map imports", async () => {
  const root = tempDir("user-source-map-import");
  const distDir = path.join(root, ".next");
  const outDir = path.join(root, "dist", "brrrd");
  const handlerPath = path.join(root, "route.cjs");

  fs.writeFileSync(path.join(root, "route.js.map"), "{\"version\":3}\n", "utf8");
  fs.writeFileSync(
    handlerPath,
    `
const map = require("./route.js.map");
module.exports = function handler(req, res) {
  res.end(String(map.version));
};
`,
    "utf8",
  );

  await assert.rejects(
    bundleAppHandler(
      [{ id: "/", filePath: handlerPath, assets: {} }],
      { projectDir: root, distDir, outDir },
    ),
    /source map imports outside Next server output are not executable|No loader is configured for ".map" files|Unexpected token/,
  );
});

test("bundleAppHandler aliases Pages RouterContext direct imports to Next vendored singleton", async () => {
  const root = tempDir("pages-router-context-singleton");
  const distDir = path.join(root, ".next");
  const outDir = path.join(root, "dist", "brrrd");
  const handlerPath = path.join(root, "route.cjs");

  fs.writeFileSync(
    handlerPath,
    `
const { RouterContext } = require("next/dist/shared/lib/router-context.shared-runtime");
module.exports = function handler(_req, res) {
  res.end(String(Boolean(RouterContext && RouterContext.Provider)));
};
`,
    "utf8",
  );

  await bundleAppHandler(
    [{ id: "/", filePath: handlerPath, assets: {} }],
    { projectDir: root, distDir, outDir },
  );

  const appBundle = fs.readFileSync(path.join(outDir, "bundles", "app.js"), "utf8");
  assert.match(
    appBundle,
    /next\/dist\/server\/route-modules\/pages\/vendored\/contexts\/router-context/,
  );
  assert.doesNotMatch(
    appBundle,
    /node_modules.*next.*router-context\.shared-runtime\.js/,
  );

  const previousBrrrdModules = globalThis.__brrrd_modules;
  globalThis.__brrrd_modules = { ...(previousBrrrdModules || {}) };
  for (const builtin of builtinModules) {
    if (builtin.startsWith("_")) continue;
    try {
      const mod = require(builtin);
      globalThis.__brrrd_modules[builtin] = mod;
      if (!builtin.startsWith("node:")) {
        globalThis.__brrrd_modules[`node:${builtin}`] = mod;
      }
    } catch {
      // Some Node builtins are compile-time aliases only.
    }
  }

  try {
    const { default: dispatch } = await import(
      `${pathToFileURL(path.join(outDir, "bundles", "app.js")).href}?${Date.now()}`
    );
    let body = "";
    await dispatch(
      "/",
      { headers: { host: "localhost" }, __brrrd_request_meta: {} },
      {
        end(chunk = "") {
          body += String(chunk);
        },
        writeHead() {},
      },
    );
    assert.equal(body, "true");
  } finally {
    if (previousBrrrdModules === undefined) {
      delete globalThis.__brrrd_modules;
    } else {
      globalThis.__brrrd_modules = previousBrrrdModules;
    }
  }
});

test("writeManifest records NEXT_DEPLOYMENT_ID as build metadata", () => {
  const root = tempDir("deployment-id");
  const previous = process.env.NEXT_DEPLOYMENT_ID;
  process.env.NEXT_DEPLOYMENT_ID = "deploy-test-123";
  try {
    writeManifest(
      root,
      { buildId: "build-1", nextVersion: "16.3.0-canary" },
      [],
      {},
      {
        headers: [],
        redirects: [],
        proxy: null,
        rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
      },
      [],
      { policies: [] },
      undefined,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.NEXT_DEPLOYMENT_ID;
    } else {
      process.env.NEXT_DEPLOYMENT_ID = previous;
    }
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.build.deploymentId, "deploy-test-123");
});

test("writeManifest records Next image optimizer policy", () => {
  const root = tempDir("image-config");
  writeManifest(
    root,
    {
      buildId: "build-1",
      nextVersion: "16.3.0-canary",
      config: {
        images: {
          domains: ["legacy.example.test"],
          remotePatterns: [{
            protocol: "https",
            hostname: "image-optimization-test.vercel.app",
            pathname: "/**",
          }],
          localPatterns: [{ pathname: "/assets/**" }],
          qualities: [50, 75],
          minimumCacheTTL: 60,
        },
      },
    },
    [],
    {},
    {
      headers: [],
      redirects: [],
      proxy: null,
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
    },
    [],
    { policies: [] },
    undefined,
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.images, {
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [32, 48, 64, 96, 128, 256, 384],
    domains: ["legacy.example.test"],
    remotePatterns: [{
      protocol: "https",
      hostname: "image-optimization-test.vercel.app",
      pathname: "/**",
    }],
    localPatterns: [{ pathname: "/assets/**" }],
    qualities: [50, 75],
    minimumCacheTTL: 60,
  });
});

test("onBuildComplete emits Next preview metadata for draft-mode routing", async () => {
  const root = tempDir("preview-metadata");
  const distDir = path.join(root, ".next");
  const appDir = path.join(distDir, "server", "app");
  const handler = path.join(appDir, "page.js");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(handler, "export default function Page() {}\n", "utf8");
  fs.writeFileSync(path.join(appDir, "index.html"), "<main>static</main>", "utf8");
  writeJson(path.join(distDir, "prerender-manifest.json"), {
    version: 4,
    routes: {
      "/": {
        initialRevalidateSeconds: false,
        srcRoute: null,
        dataRoute: null,
      },
    },
    dynamicRoutes: {},
    preview: {
      previewModeId: "preview-id",
      previewModeSigningKey: "signing-key",
      previewModeEncryptionKey: "encryption-key",
    },
  });

  const context = minimalContext(root, distDir, {
    id: "/",
    pathname: "/",
    filePath: handler,
    assets: {},
  });
  context.outputs.prerenders = [
    { id: "/", pathname: "/", filePath: path.join(appDir, "index.html") },
  ];

  await onBuildComplete(context);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.preview, {
    previewModeId: "preview-id",
    previewModeSigningKey: "signing-key",
    previewModeEncryptionKey: "encryption-key",
  });
});

test("onBuildComplete rejects edge app route outputs without function metadata", async () => {
  const root = tempDir("edge-app-route");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  fs.writeFileSync(
    handler,
    "throw new ReferenceError('self is not defined');\nexport function handler() {}\n",
    "utf8",
  );

  await assert.rejects(
    onBuildComplete(
      minimalContext(root, distDir, {
        id: "/apple-icon/route",
        pathname: "/apple-icon",
        runtime: "edge",
        filePath: handler,
        assets: {},
      }),
    ),
    /edge app\/page\/api route outputs are missing Adapter API edgeRuntime metadata or middleware-manifest\.functions fallback metadata/,
  );
});

test("onBuildComplete uses Adapter API edgeRuntime metadata without middleware-manifest functions", async () => {
  const root = tempDir("edge-runtime-adapter-api");
  const distDir = path.join(root, ".next");
  const runtimeRel = "server/chunks/edge-runtime.js";
  const entryRel = "server/app/app-ssr-edge/page.js";
  const runtimePath = path.join(distDir, runtimeRel);
  const entryPath = path.join(distDir, entryRel);
  for (const filePath of [runtimePath, entryPath]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "", "utf8");
  }

  await onBuildComplete(
    minimalContext(root, distDir, {
      id: "app/app-ssr-edge/page.rsc",
      pathname: "/app-ssr-edge.rsc",
      runtime: "edge",
      filePath: entryPath,
      sourcePage: "/app-ssr-edge/page",
      edgeRuntime: {
        modulePath: entryPath,
        entryKey: "middleware_app/app-ssr-edge/page",
        handlerExport: "handler",
      },
      assets: {
        [runtimeRel]: runtimePath,
        [entryRel]: entryPath,
      },
      wasmAssets: {},
      config: { env: { EDGE_FLAG: "yes" } },
    }),
  );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  const edgeFn = manifest.edgeFunctions["app-app-ssr-edge-page_rsc"];
  assert.equal(edgeFn.entry, entryRel);
  assert.equal(edgeFn.entryKey, "middleware_app/app-ssr-edge/page");
  assert.equal(edgeFn.name, "app/app-ssr-edge/page");
  assert.equal(edgeFn.handlerExport, "handler");
  assert.deepEqual(edgeFn.env, { EDGE_FLAG: "yes" });
  assert.equal(
    fs.existsSync(path.join(root, "dist", "brrrd", "runtime", entryRel)),
    true,
  );
});

test("onBuildComplete compiles Adapter API node proxy middleware without middleware-manifest entry", async () => {
  const root = tempDir("node-proxy-middleware-output");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  const runtimeRel = "server/webpack-runtime.js";
  const runtimePath = path.join(distDir, runtimeRel);
  const middlewareRel = "server/middleware.js";
  const middlewarePath = path.join(distDir, middlewareRel);

  fs.writeFileSync(path.join(root, "proxy.ts"), "export function proxy() {}\n", "utf8");
  fs.writeFileSync(handler, "export default function handler() {}\n", "utf8");
  fs.mkdirSync(path.dirname(middlewarePath), { recursive: true });
  fs.writeFileSync(runtimePath, "globalThis.__webpack_require__ = function() {};\n", "utf8");
  fs.writeFileSync(middlewarePath, "globalThis._ENTRIES = globalThis._ENTRIES || {};\n", "utf8");
  writeJson(path.join(distDir, "server", "middleware-manifest.json"), {
    middleware: {},
    functions: {},
    sortedMiddleware: [],
  });

  const context = minimalContext(root, distDir, {
    id: "/",
    pathname: "/",
    filePath: handler,
    assets: {},
  });
  context.outputs.middleware = {
    id: "/_middleware",
    pathname: "/_middleware",
    type: "MIDDLEWARE",
    runtime: "nodejs",
    filePath: middlewarePath,
    sourcePage: "middleware",
    assets: {
      [middlewareRel]: middlewarePath,
      [runtimeRel]: runtimePath,
    },
    config: {
      matchers: [{
        source: "/:path*",
        sourceRegex: "^/.*$",
        has: [{ type: "header", key: "x-proxy-test", value: "1" }],
        missing: [{ type: "header", key: "x-prerender-revalidate", value: "preview" }],
      }],
    },
  };

  await onBuildComplete(context);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.routing.proxy, { source: "proxy" });
  assert.deepEqual(manifest.middleware, {
    moduleFormat: "node",
    files: [runtimeRel, middlewareRel],
    runtime: runtimeRel,
    entry: middlewareRel,
    name: "middleware",
    page: "/proxy",
    matchers: [{
      regexp: "^/.*$",
      originalSource: "/:path*",
      has: [{ type: "header", key: "x-proxy-test", value: "1" }],
      missing: [{ type: "header", key: "x-prerender-revalidate", value: "preview" }],
    }],
    wasm: [],
    assets: [],
    env: {},
  });
  assert.equal(
    fs.existsSync(path.join(root, "dist", "brrrd", "runtime", middlewareRel)),
    true,
  );
  assert.equal(
    manifest.artifacts.some((artifact) => (
      artifact.kind === "middleware" && artifact.packagePath === `runtime/${middlewareRel}`
    )),
    true,
  );
});

test("onBuildComplete preserves Adapter API node middleware root package assets", async () => {
  const root = tempDir("node-proxy-root-assets");
  const distDir = path.join(root, ".next");
  const runtimeRel = "server/webpack-runtime.js";
  const runtimePath = path.join(distDir, runtimeRel);
  const middlewareRel = "server/middleware.js";
  const middlewarePath = path.join(distDir, middlewareRel);

  writeJson(path.join(root, "package.json"), {
    dependencies: { fixture: "1.0.0" },
  });
  writeJson(path.join(distDir, "package.json"), { type: "commonjs" });
  fs.mkdirSync(path.dirname(middlewarePath), { recursive: true });
  fs.writeFileSync(runtimePath, "globalThis.__webpack_require__ = function() {};\n", "utf8");
  fs.writeFileSync(middlewarePath, "globalThis._ENTRIES = globalThis._ENTRIES || {};\n", "utf8");
  writeJson(path.join(distDir, "server", "middleware-manifest.json"), {
    middleware: {},
    functions: {},
    sortedMiddleware: [],
  });

  const context = minimalContext(root, distDir, {
    id: "/",
    pathname: "/",
    filePath: middlewarePath,
    assets: {},
  });
  context.outputs.appPages = [];
  context.outputs.middleware = {
    id: "/_middleware",
    pathname: "/_middleware",
    type: "MIDDLEWARE",
    runtime: "nodejs",
    filePath: middlewarePath,
    sourcePage: "middleware",
    assets: {
      [middlewareRel]: middlewarePath,
      [runtimeRel]: runtimePath,
      "package.json": path.join(root, "package.json"),
      ".next/package.json": path.join(distDir, "package.json"),
    },
    config: { matchers: [] },
  };

  await onBuildComplete(context);

  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, "dist", "brrrd", "runtime", "package.json"), "utf8")),
    { dependencies: { fixture: "1.0.0" } },
  );
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(root, "dist", "brrrd", "runtime", ".next", "package.json"), "utf8"),
    ),
    { type: "commonjs" },
  );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.artifacts.some((artifact) =>
      artifact.packagePath === "runtime/package.json"
        && artifact.sourcePath === "package.json"
        && artifact.reason === "Next Adapter API proxy/middleware runtime asset"
    ),
    true,
  );
  assert.equal(
    manifest.artifacts.some((artifact) =>
      artifact.packagePath === "runtime/.next/package.json"
        && artifact.sourcePath === ".next/package.json"
        && artifact.reason === "Next Adapter API proxy/middleware runtime asset"
    ),
    true,
  );
});

test("onBuildComplete packages compiled next-server runtimes for node proxy middleware", async () => {
  const root = tempDir("node-proxy-next-server-runtime");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  const runtimeRel = "server/webpack-runtime.js";
  const middlewareRel = "server/middleware.js";
  const runtimePath = path.join(distDir, runtimeRel);
  const middlewarePath = path.join(distDir, middlewareRel);
  const nextServerDir = path.join(
    root,
    "node_modules",
    "next",
    "dist",
    "compiled",
    "next-server",
  );
  const sourceMapDir = path.join(root, "node_modules", "next", "dist", "compiled", "source-map");
  const stacktraceDir = path.join(root, "node_modules", "next", "dist", "compiled", "stacktrace-parser");
  const moduleLoadingDir = path.join(
    root,
    "node_modules",
    "next",
    "dist",
    "server",
    "app-render",
    "module-loading",
  );
  const cacheSignalPath = path.join(
    root,
    "node_modules",
    "next",
    "dist",
    "server",
    "app-render",
    "cache-signal.js",
  );

  fs.writeFileSync(path.join(root, "proxy.ts"), "export function proxy() {}\n", "utf8");
  fs.writeFileSync(handler, "export default function handler() {}\n", "utf8");
  fs.mkdirSync(path.dirname(middlewarePath), { recursive: true });
  fs.writeFileSync(runtimePath, "module.exports = function __webpack_require__() {};\n", "utf8");
  fs.writeFileSync(middlewarePath, "module.exports.default = async () => ({ response: new Response(null) });\n", "utf8");
  fs.mkdirSync(nextServerDir, { recursive: true });
  fs.mkdirSync(sourceMapDir, { recursive: true });
  fs.mkdirSync(stacktraceDir, { recursive: true });
  fs.mkdirSync(moduleLoadingDir, { recursive: true });
  fs.mkdirSync(path.dirname(cacheSignalPath), { recursive: true });
  writeJson(path.join(root, "node_modules", "next", "package.json"), {
    name: "next",
    version: "16.3.0-test",
  });
  fs.writeFileSync(
    path.join(nextServerDir, "pages.runtime.prod.js"),
    "module.exports = require('next/dist/compiled/stacktrace-parser');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(nextServerDir, "app-page.runtime.prod.js"),
    "require('next/dist/server/app-render/module-loading/track-module-loading.external.js'); module.exports = require('next/dist/compiled/source-map');\n",
    "utf8",
  );
  fs.writeFileSync(path.join(nextServerDir, "not-runtime.js"), "module.exports = {};\n", "utf8");
  writeJson(path.join(sourceMapDir, "package.json"), { main: "source-map.js" });
  fs.writeFileSync(
    path.join(sourceMapDir, "source-map.js"),
    "module.exports = require('next/dist/compiled/stacktrace-parser');\n",
    "utf8",
  );
  fs.writeFileSync(path.join(stacktraceDir, "index.js"), "module.exports = {};\n", "utf8");
  fs.writeFileSync(
    path.join(moduleLoadingDir, "track-module-loading.external.js"),
    "module.exports = require('./track-module-loading.instance');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(moduleLoadingDir, "track-module-loading.instance.js"),
    "module.exports = require('../cache-signal');\n",
    "utf8",
  );
  fs.writeFileSync(cacheSignalPath, "module.exports = { CacheSignal: function CacheSignal() {} };\n", "utf8");
  writeJson(path.join(distDir, "server", "middleware-manifest.json"), {
    middleware: {},
    functions: {},
    sortedMiddleware: [],
  });

  const context = minimalContext(root, distDir, {
    id: "/",
    pathname: "/",
    filePath: handler,
    assets: {},
  });
  context.outputs.middleware = {
    id: "/_middleware",
    pathname: "/_middleware",
    type: "MIDDLEWARE",
    runtime: "nodejs",
    filePath: middlewarePath,
    sourcePage: "middleware",
    assets: {
      [middlewareRel]: middlewarePath,
      [runtimeRel]: runtimePath,
    },
    config: {
      matchers: [{ source: "/:path*", sourceRegex: "^/.*$" }],
    },
  };

  await onBuildComplete(context);

  const packagedDir = path.join(
    root,
    "dist",
    "brrrd",
    "runtime",
    "node_modules",
    "next",
    "dist",
    "compiled",
    "next-server",
  );
  assert.equal(fs.existsSync(path.join(packagedDir, "pages.runtime.prod.js")), true);
  assert.equal(fs.existsSync(path.join(packagedDir, "app-page.runtime.prod.js")), true);
  assert.equal(fs.existsSync(path.join(packagedDir, "not-runtime.js")), false);
  assert.equal(
    fs.existsSync(path.join(
      root,
      "dist",
      "brrrd",
      "runtime",
      "node_modules",
      "next",
      "dist",
      "compiled",
      "source-map",
      "source-map.js",
    )),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(
      root,
      "dist",
      "brrrd",
      "runtime",
      "node_modules",
      "next",
      "dist",
      "server",
      "app-render",
      "module-loading",
      "track-module-loading.external.js",
    )),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(
      root,
      "dist",
      "brrrd",
      "runtime",
      "node_modules",
      "next",
      "dist",
      "server",
      "app-render",
      "module-loading",
      "track-module-loading.instance.js",
    )),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(
      root,
      "dist",
      "brrrd",
      "runtime",
      "node_modules",
      "next",
      "dist",
      "server",
      "app-render",
      "cache-signal.js",
    )),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(
      root,
      "dist",
      "brrrd",
      "runtime",
      "node_modules",
      "next",
      "dist",
      "compiled",
      "stacktrace-parser",
      "index.js",
    )),
    true,
  );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.artifacts.some((artifact) => (
      artifact.kind === "runtime-file"
      && artifact.packagePath === "runtime/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js"
    )),
    true,
  );
  assert.equal(
    manifest.artifacts.some((artifact) => (
      artifact.kind === "runtime-file"
      && artifact.packagePath === "runtime/node_modules/next/dist/compiled/source-map/source-map.js"
    )),
    true,
  );
  assert.equal(
    manifest.artifacts.some((artifact) => (
      artifact.kind === "runtime-file"
      && artifact.packagePath === "runtime/node_modules/next/dist/server/app-render/module-loading/track-module-loading.external.js"
    )),
    true,
  );
});

test("onBuildComplete emits edge app route function metadata and artifacts", async () => {
  const root = tempDir("edge-app-route");
  const distDir = path.join(root, ".next");
  const edgeFiles = [
    "server/chunks/edge-runtime.js",
    "server/app/api/edge/route.js",
  ];
  for (const file of edgeFiles) {
    fs.mkdirSync(path.dirname(path.join(distDir, file)), { recursive: true });
    fs.writeFileSync(path.join(distDir, file), "", "utf8");
  }
  const fontAsset = "server/edge-chunks/asset_Test-Regular.1234.ttf";
  fs.mkdirSync(path.dirname(path.join(distDir, fontAsset)), { recursive: true });
  fs.writeFileSync(path.join(distDir, fontAsset), "font-bytes", "utf8");
  writeJson(path.join(distDir, "server", "middleware-manifest.json"), {
    middleware: {},
    functions: {
      "/api/edge/route": {
        files: edgeFiles,
        entrypoint: "server/app/api/edge/route.js",
        name: "app/api/edge/route",
        page: "/api/edge/route",
        wasm: [],
        assets: [],
        env: { __NEXT_BUILD_ID: "test-build" },
      },
    },
  });

  await onBuildComplete({
    ...minimalContext(root, distDir, {
      id: "/",
      pathname: "/",
      filePath: path.join(root, "unused.js"),
    }),
    outputs: {
      pages: [],
      appPages: [],
      appRoutes: [{
        id: "app/api/edge/route",
        pathname: "/api/edge",
        runtime: "edge",
        filePath: path.join(distDir, "server", "app", "api", "edge", "route.js"),
        edgeRuntime: {
          modulePath: path.join(distDir, "server", "app", "api", "edge", "route.js"),
          entryKey: "middleware_app/api/edge/route",
          handlerExport: "handler",
        },
        assets: {
          "server/chunks/edge-runtime.js": path.join(distDir, "server", "chunks", "edge-runtime.js"),
          "server/app/api/edge/route.js": path.join(distDir, "server", "app", "api", "edge", "route.js"),
          "Test-Regular.1234.ttf": path.join(distDir, fontAsset),
        },
      }],
      pagesApi: [],
      middleware: undefined,
      prerenders: [],
      staticFiles: [],
    },
  });

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 6);
  assert.equal(manifest.routes.find((route) => route.id === "app-api-edge-route").runtime, "edge");
  assert.equal(
    manifest.edgeFunctions["app-api-edge-route"].entry,
    "server/app/api/edge/route.js",
  );
  assert.equal(
    manifest.edgeFunctions["app-api-edge-route"].entryKey,
    "middleware_app/api/edge/route",
  );
  assert.deepEqual(
    manifest.edgeFunctions["app-api-edge-route"].files,
    edgeFiles,
  );
  assert.deepEqual(
    manifest.edgeFunctions["app-api-edge-route"].assets,
    [{ name: "Test-Regular.1234.ttf", filePath: fontAsset }],
  );
  assert.equal(
    fs.existsSync(
      path.join(root, "dist", "brrrd", "runtime", "server", "app", "api", "edge", "route.js"),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(root, "dist", "brrrd", "runtime", fontAsset),
    ),
    true,
  );
});

test("onBuildComplete copies app prerender artifacts into runtime fs", async () => {
  const root = tempDir("app-prerender-artifacts");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('ok'); }\n",
    "utf8",
  );

  const appPrerenderDir = path.join(distDir, "server", "app", "posts");
  const dynamicDir = path.join(appPrerenderDir, "[id]");
  fs.mkdirSync(path.join(dynamicDir + ".segments", "posts", "$d$id"), { recursive: true });
  fs.writeFileSync(path.join(appPrerenderDir, "[id].html"), "<!doctype html>", "utf8");
  fs.writeFileSync(path.join(appPrerenderDir, "[id].meta"), "{}", "utf8");
  fs.writeFileSync(path.join(appPrerenderDir, "[id].segments", "_tree.segment.rsc"), "tree", "utf8");
  fs.writeFileSync(
    path.join(appPrerenderDir, "[id].segments", "posts", "$d$id", "__PAGE__.segment.rsc"),
    "page",
    "utf8",
  );
  fs.mkdirSync(dynamicDir, { recursive: true });
  fs.writeFileSync(path.join(dynamicDir, "page.js"), "server bundle", "utf8");

  const context = minimalContext(root, distDir, {
    id: "/posts/[id]/page",
    pathname: "/posts/[id]",
    filePath: handler,
    assets: {},
  });
  context.outputs.prerenders = [
    {
      id: "/posts/[id]",
      pathname: "/posts/[id]",
      filePath: path.join(appPrerenderDir, "[id].html"),
    },
  ];
  context.routing.dynamicRoutes = [
    {
      source: "/posts/[id]",
      sourceRegex: "^/posts/([^/]+)$",
      destination: "/posts/[id]",
    },
  ];

  await onBuildComplete(context);

  const runtimeApp = path.join(root, "dist", "brrrd", "runtime", ".next", "server", "app");
  assert.equal(fs.existsSync(path.join(runtimeApp, "posts", "[id].html")), true);
  assert.equal(fs.existsSync(path.join(runtimeApp, "posts", "[id].meta")), true);
  assert.equal(
    fs.existsSync(path.join(runtimeApp, "posts", "[id].segments", "_tree.segment.rsc")),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(runtimeApp, "posts", "[id].segments", "posts", "$d$id", "__PAGE__.segment.rsc"),
    ),
    true,
  );
  assert.equal(fs.existsSync(path.join(runtimeApp, "posts", "[id]", "page.js")), false);
});

test("onBuildComplete emits App prerender response metadata from .meta files", async () => {
  const root = tempDir("app-prerender-response-meta");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('dynamic'); }\n",
    "utf8",
  );

  const appDir = path.join(distDir, "server", "app");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "redirect-page.html"), "<!doctype html>", "utf8");
  writeJson(path.join(appDir, "redirect-page.meta"), {
    status: 307,
    headers: {
      location: "/",
      "x-nextjs-prerender": "1",
    },
  });

  const context = minimalContext(root, distDir, {
    id: "/redirect-page/page",
    pathname: "/redirect-page",
    filePath: handler,
    assets: {},
  });
  context.outputs.prerenders = [
    {
      id: "/redirect-page",
      pathname: "/redirect-page",
      filePath: path.join(appDir, "redirect-page.html"),
    },
  ];

  await onBuildComplete(context);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.routes.find((route) => route.id === "prerender-redirect-page"),
    {
      id: "prerender-redirect-page",
      pattern: "^/redirect-page$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/redirect-page",
      status: 307,
      headers: [
        { key: "location", value: "/" },
        { key: "x-nextjs-prerender", value: "1" },
      ],
    },
  );
});

test("extractAppPrerenderResponseMeta reads status and headers from App .meta files", () => {
  const root = tempDir("app-prerender-meta-supplement");
  const distDir = path.join(root, ".next");
  const appDir = path.join(distDir, "server", "app");
  writeJson(path.join(appDir, "not-found-page.meta"), {
    status: 404,
    headers: {
      "x-nextjs-prerender": "1",
    },
  });
  writeJson(path.join(appDir, "index.meta"), {
    headers: {
      "x-next-cache-tags": "_N_T_/",
    },
  });

  assert.deepEqual(extractAppPrerenderResponseMeta(distDir), [
    {
      pathname: "/",
      headers: [{ key: "x-next-cache-tags", value: "_N_T_/" }],
    },
    {
      pathname: "/not-found-page",
      status: 404,
      headers: [{ key: "x-nextjs-prerender", value: "1" }],
    },
  ]);
});

test("extractAppPrerenderResponseMeta preserves static prerender bypass conditions", () => {
  const root = tempDir("app-prerender-bypass-supplement");
  const distDir = path.join(root, ".next");
  const appDir = path.join(distDir, "server", "app");
  writeJson(path.join(appDir, "index.meta"), {
    headers: {
      "x-nextjs-prerender": "1",
    },
  });
  writeJson(path.join(distDir, "prerender-manifest.json"), {
    routes: {
      "/": {
        experimentalPPR: true,
        experimentalBypassFor: [
          { type: "header", key: "next-action" },
          { type: "header", key: "content-type", value: "multipart/form-data;.*" },
        ],
      },
    },
  });

  assert.deepEqual(extractAppPrerenderResponseMeta(distDir), [
    {
      pathname: "/",
      headers: [{ key: "x-nextjs-prerender", value: "1" }],
      prerenderBypass: [
        { type: "header", key: "next-action" },
        { type: "header", key: "content-type", value: "multipart/form-data;.*" },
      ],
    },
  ]);
});

test("extractAppStaticResponseMeta reads metadata route .body response headers", () => {
  const root = tempDir("app-static-meta-supplement");
  const distDir = path.join(root, ".next");
  const appDir = path.join(distDir, "server", "app");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "manifest.webmanifest.body"), "{\"name\":\"test\"}", "utf8");
  writeJson(path.join(appDir, "manifest.webmanifest.meta"), {
    status: 200,
    headers: {
      "content-type": "application/manifest+json",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
  writeJson(path.join(appDir, "unpaired.meta"), {
    headers: {
      "cache-control": "must not leak",
    },
  });

  assert.deepEqual(extractAppStaticResponseMeta(distDir), [
    {
      pathname: "/manifest.webmanifest",
      sourceRel: "manifest.webmanifest.meta",
      status: 200,
      headers: [
        { key: "content-type", value: "application/manifest+json" },
        { key: "cache-control", value: "public, max-age=0, must-revalidate" },
      ],
    },
  ]);
});

test("onBuildComplete emits App metadata static response headers from .meta files", async () => {
  const root = tempDir("app-static-response-meta");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('dynamic'); }\n",
    "utf8",
  );

  const appDir = path.join(distDir, "server", "app");
  const bodyFile = path.join(appDir, "manifest.webmanifest.body");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(bodyFile, "{\"name\":\"test\"}", "utf8");
  writeJson(path.join(appDir, "manifest.webmanifest.meta"), {
    status: 200,
    headers: {
      "content-type": "application/manifest+json",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });

  const context = minimalContext(root, distDir, {
    id: "/page",
    pathname: "/",
    filePath: handler,
    assets: {},
  });
  context.outputs.staticFiles = [
    {
      id: "/manifest.webmanifest",
      pathname: "/manifest.webmanifest",
      filePath: bodyFile,
    },
  ];

  await onBuildComplete(context);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.routes.find((route) => route.id === "static-manifest_webmanifest"),
    {
      id: "static-manifest_webmanifest",
      pattern: "^/manifest\\.webmanifest$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/manifest.webmanifest",
      immutable: false,
      status: 200,
      headers: [
        { key: "content-type", value: "application/manifest+json" },
        { key: "cache-control", value: "public, max-age=0, must-revalidate" },
      ],
    },
  );
  assert.deepEqual(
    manifest.artifacts.find((artifact) => artifact.id === "static:manifest_webmanifest"),
    {
      id: "static:manifest_webmanifest",
      kind: "static",
      ownerRouteId: "static-manifest_webmanifest",
      sourcePath: ".next/server/app/manifest.webmanifest.body",
      packagePath: "static/manifest.webmanifest",
      mountPath: "/manifest.webmanifest",
      contentType: "application/manifest+json",
      immutable: false,
      required: true,
      reason: "Next Adapter API staticFiles output",
    },
  );
});

test("onBuildComplete publishes static App metadata route prerenders before dynamic handlers", async () => {
  const root = tempDir("app-metadata-route-prerender");
  const distDir = path.join(root, ".next");
  const handler = path.join(distDir, "server", "app", "products", "sitemap", "[__metadata_id__]", "route.js");
  const bodyFile = path.join(distDir, "server", "app", "products", "sitemap", "1.xml.body");
  const metaFile = path.join(distDir, "server", "app", "products", "sitemap", "1.xml.meta");

  fs.mkdirSync(path.dirname(handler), { recursive: true });
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  fs.writeFileSync(handler, "export function handler(_req, res) { res.end('runtime'); }\n", "utf8");
  fs.writeFileSync(bodyFile, "<urlset>buildtime</urlset>", "utf8");
  writeJson(metaFile, {
    status: 200,
    headers: {
      "content-type": "application/xml",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });

  const context = minimalContext(root, distDir, {
    id: "/",
    pathname: "/",
    filePath: path.join(distDir, "server", "app", "page.js"),
    assets: {},
  });
  fs.mkdirSync(path.dirname(context.outputs.appPages[0].filePath), { recursive: true });
  fs.writeFileSync(context.outputs.appPages[0].filePath, "export function handler() {}\n", "utf8");
  context.outputs.appRoutes = [
    {
      id: "/products/sitemap/[__metadata_id__]/route",
      pathname: "/products/sitemap/[__metadata_id__]",
      filePath: handler,
      runtime: "nodejs",
      sourcePage: "/products/sitemap/[__metadata_id__]/route",
      assets: {},
    },
  ];
  context.outputs.prerenders = [
    {
      id: "/products/sitemap/1.xml",
      pathname: "/products/sitemap/1.xml",
      filePath: bodyFile,
      sourcePage: "/products/sitemap/[__metadata_id__]",
    },
  ];
  context.routing.dynamicRoutes = [
    {
      source: "/products/sitemap/[__metadata_id__]",
      sourceRegex: "^/products/sitemap/([^/]+?)(?:/)?$",
      destination: "/products/sitemap/[__metadata_id__]",
    },
  ];

  await onBuildComplete(context);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  const staticRoute = manifest.routes.find((route) => route.id === "prerender-products-sitemap-1_xml");
  const handlerRoute = manifest.routes.find((route) => route.id === "products-sitemap-___metadata_id___-route");
  assert.ok(staticRoute);
  assert.ok(handlerRoute);
  assert.equal(manifest.routes.indexOf(staticRoute) < manifest.routes.indexOf(handlerRoute), true);
  assert.deepEqual(staticRoute, {
    id: "prerender-products-sitemap-1_xml",
    pattern: "^/products/sitemap/1\\.xml$",
    type: "prerender",
    runtime: "nodejs",
    bundle: "",
    file: "/products/sitemap/1.xml",
    status: 200,
    headers: [
      { key: "content-type", value: "application/xml" },
      { key: "cache-control", value: "public, max-age=0, must-revalidate" },
    ],
  });
  assert.deepEqual(
    manifest.artifacts.find((artifact) => artifact.id === "prerender:products-sitemap-1_xml"),
    {
      id: "prerender:products-sitemap-1_xml",
      kind: "prerender",
      ownerRouteId: "prerender-products-sitemap-1_xml",
      sourcePath: ".next/server/app/products/sitemap/1.xml.body",
      packagePath: "static/products/sitemap/1.xml",
      mountPath: "/products/sitemap/1.xml",
      contentType: "application/xml",
      required: true,
      reason: "static route-handler prerender response served without invoking the handler",
    },
  );
  assert.equal(
    fs.readFileSync(path.join(root, "dist", "brrrd", "static", "products", "sitemap", "1.xml"), "utf8"),
    "<urlset>buildtime</urlset>",
  );
});

test("onBuildComplete does not publish Pages Router rsc-fallback as RSC data", async () => {
  const root = tempDir("pages-rsc-fallback");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('dynamic'); }\n",
    "utf8",
  );

  const pagesHtml = path.join(distDir, "server", "pages", "pages-dir.html");
  const rscFallback = path.join(distDir, "server", "rsc-fallback.json");
  fs.mkdirSync(path.dirname(pagesHtml), { recursive: true });
  fs.writeFileSync(pagesHtml, "<html><body>Hello from a pages route</body></html>", "utf8");
  fs.writeFileSync(rscFallback, "{}", "utf8");

  const context = minimalContext(root, distDir, {
    id: "/page",
    pathname: "/",
    filePath: handler,
    assets: {},
  });
  context.outputs.staticFiles = [
    {
      id: "/pages-dir",
      pathname: "/pages-dir",
      filePath: pagesHtml,
    },
    {
      id: "/pages-dir.rsc",
      pathname: "/pages-dir.rsc",
      filePath: rscFallback,
    },
  ];

  await onBuildComplete(context);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.routes.some((route) => route.id === "static-pages-dir_rsc"),
    false,
  );
  assert.equal(
    manifest.artifacts.some((artifact) => artifact.id === "static:pages-dir_rsc"),
    false,
  );
  assert.ok(manifest.routes.some((route) => route.id === "static-pages-dir"));
  assert.ok(manifest.artifacts.some((artifact) => artifact.id === "static:pages-dir"));
});

test("onBuildComplete exposes PPR segment prefetch artifacts through the static store", async () => {
  const root = tempDir("ppr-segment-prefetch");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('dynamic'); }\n",
    "utf8",
  );

  const segmentFile = path.join(
    distDir,
    "server",
    "app",
    "alpha.segments",
    "$d$slug",
    "__PAGE__.segment.rsc",
  );
  fs.mkdirSync(path.dirname(segmentFile), { recursive: true });
  fs.writeFileSync(segmentFile, "segment", "utf8");
  const routeRscFile = path.join(distDir, "server", "app", "alpha.rsc");
  fs.writeFileSync(routeRscFile, "route-rsc", "utf8");
  const treeSegmentFile = path.join(
    distDir,
    "server",
    "app",
    "alpha.segments",
    "_tree.segment.rsc",
  );
  fs.writeFileSync(treeSegmentFile, "tree", "utf8");
  writeJson(path.join(distDir, "routes-manifest.json"), {
    dynamicRoutes: [{
      page: "/[slug]",
      namedRegex: "^/(?<nxtPslug>[^/]+?)(?:/)?$",
      prefetchSegmentDataRoutes: [{
        source: "^/(?<nxtPslug>[^/]+?)\\.segments/\\$d\\$slug(?<segment>/__PAGE__\\.segment\\.rsc|\\.segment\\.rsc)(?:/)?$",
        destination: "/[slug].segments/$d$slug$segment",
      }],
    }],
  });

  const context = minimalContext(root, distDir, {
    id: "/[slug]/page",
    pathname: "/[slug]",
    filePath: handler,
    assets: {},
  });
  context.outputs.appPages.push({
    id: "/[slug]/page.rsc",
    pathname: "/[slug].rsc",
    filePath: handler,
    assets: {},
  });
  context.routing.dynamicRoutes = [
    {
      source: "/[slug]",
      sourceRegex: "^/(?<nxtPslug>[^/]+?)(?:/)?$",
      destination: "/[slug]",
    },
    {
      source: "/[slug].rsc",
      sourceRegex: "^/(?<nxtPslug>[^/]+?)(?<rscSuffix>\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$",
      destination: "/[slug].rsc",
    },
  ];

  await onBuildComplete(context);

  assert.equal(
    fs.existsSync(
      path.join(root, "dist", "brrrd", "static", "alpha.segments", "$d$slug", "__PAGE__.segment.rsc"),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(root, "dist", "brrrd", "static", "alpha.rsc")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(root, "dist", "brrrd", "static", "alpha.segments", "_tree.segment.rsc")),
    true,
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  const segmentRouteIndex = manifest.routes.findIndex((route) => (
    route.id === "ppr-segment-_slug_-0"
  ));
  const dynamicRscIndex = manifest.routes.findIndex((route) => (
    route.type === "page" && route.pattern.includes("rscSuffix")
  ));
  assert.ok(segmentRouteIndex >= 0);
  assert.ok(dynamicRscIndex >= 0);
  assert.ok(segmentRouteIndex < dynamicRscIndex);
  assert.equal(manifest.routes[segmentRouteIndex].type, "static");
  assert.equal(manifest.routes[segmentRouteIndex].file, "/[slug].segments/$d$slug$segment");
  assert.deepEqual(
    manifest.routes.find((route) => route.id === "app-prerender-data-alpha_rsc"),
    {
      id: "app-prerender-data-alpha_rsc",
      pattern: "^/alpha\\.rsc$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/alpha.rsc",
    },
  );
  assert.ok(manifest.artifacts.some((artifact) => (
    artifact.packagePath === "static/alpha.segments/$d$slug/__PAGE__.segment.rsc"
    && artifact.contentType === "text/x-component"
  )));
});

test("onBuildComplete maps dynamic PPR tree segment artifacts to concrete segment prefetch paths", async () => {
  const root = tempDir("dynamic-ppr-tree-segment");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('dynamic'); }\n",
    "utf8",
  );

  const treeSegmentFile = path.join(
    distDir,
    "server",
    "app",
    "[teamSlug]",
    "[project].segments",
    "_tree.segment.rsc",
  );
  fs.mkdirSync(path.dirname(treeSegmentFile), { recursive: true });
  fs.writeFileSync(treeSegmentFile, "tree", "utf8");
  fs.writeFileSync(
    path.join(distDir, "server", "app", "[teamSlug]", "[project].rsc"),
    "route-rsc",
    "utf8",
  );
  writeJson(path.join(distDir, "prerender-manifest.json"), {
    dynamicRoutes: {
      "/[teamSlug]/[project]": {
        routeRegex: "^\\/([^/]+?)\\/([^/]+?)(?:\\/)?$",
        dataRouteRegex: "^/_next/data/test-build/([^/]+?)/([^/]+?)\\.json$",
        fallback: null,
      },
    },
  });

  const context = minimalContext(root, distDir, {
    id: "/[teamSlug]/[project]/page",
    pathname: "/[teamSlug]/[project]",
    filePath: handler,
    assets: {},
  });
  context.outputs.appPages.push({
    id: "/[teamSlug]/[project]/page.rsc",
    pathname: "/[teamSlug]/[project].rsc",
    filePath: handler,
    assets: {},
  });
  context.routing.dynamicRoutes = [
    {
      source: "/[teamSlug]/[project]",
      sourceRegex: "^/(?<nxtPteamSlug>[^/]+?)/(?<nxtPproject>[^/]+?)(?:/)?$",
      destination: "/[teamSlug]/[project]",
    },
    {
      source: "/[teamSlug]/[project].rsc",
      sourceRegex: "^/(?<nxtPteamSlug>[^/]+?)/(?<nxtPproject>[^/]+?)(?<rscSuffix>\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$",
      destination: "/[teamSlug]/[project].rsc",
    },
  ];

  await onBuildComplete(context);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  const dynamicTreeIndex = manifest.routes.findIndex((route) => (
    route.id === "app-prerender-data-dynamic-_teamSlug_-_project__segments-_tree_segment_rsc"
  ));
  const dynamicRscIndex = manifest.routes.findIndex((route) => (
    route.type === "page" && route.pattern.includes("rscSuffix")
  ));
  assert.ok(dynamicTreeIndex >= 0);
  assert.ok(dynamicRscIndex >= 0);
  assert.ok(dynamicTreeIndex < dynamicRscIndex);

  const dynamicTreeRoute = manifest.routes[dynamicTreeIndex];
  assert.equal(dynamicTreeRoute.type, "static");
  assert.equal(dynamicTreeRoute.file, "/[teamSlug]/[project].segments/_tree.segment.rsc");
  assert.deepEqual(dynamicTreeRoute.params, ["teamSlug", "project"]);
  assert.equal(
    new RegExp(dynamicTreeRoute.pattern).test("/acme/dashboard.segments/_tree.segment.rsc"),
    true,
  );
});

test("extractPprSegmentPrefetchRoutes preserves dynamic route segment metadata", () => {
  const root = tempDir("prefetch-segment-supplement");
  const distDir = path.join(root, ".next");
  writeJson(path.join(distDir, "routes-manifest.json"), {
    dynamicRoutes: [{
      page: "/blog/[slug]",
      prefetchSegmentDataRoutes: [{
        source: "^/blog/(?<nxtPslug>[^/]+?)\\.segments/\\$d\\$slug(?<segment>/__PAGE__\\.segment\\.rsc|\\.segment\\.rsc)(?:/)?$",
        destination: "/blog/[slug].segments/$d$slug$segment",
      }],
    }],
  });

  assert.deepEqual(extractPprSegmentPrefetchRoutes(distDir), [{
    page: "/blog/[slug]",
    source: "^/blog/(?<nxtPslug>[^/]+?)\\.segments/\\$d\\$slug(?<segment>/__PAGE__\\.segment\\.rsc|\\.segment\\.rsc)(?:/)?$",
    destination: "/blog/[slug].segments/$d$slug$segment",
  }]);
});

test("extractAppPrerenderDataRoutes discovers App Router RSC data artifacts", () => {
  const root = tempDir("app-prerender-data-supplement");
  const distDir = path.join(root, ".next");
  const appDir = path.join(distDir, "server", "app");
  fs.mkdirSync(path.join(appDir, "alpha.segments"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "alpha.rsc"), "route", "utf8");
  fs.writeFileSync(path.join(appDir, "alpha.segments", "_tree.segment.rsc"), "tree", "utf8");

  assert.deepEqual(extractAppPrerenderDataRoutes(distDir), [
    { pathname: "/alpha.rsc", sourceRel: "alpha.rsc" },
    {
      pathname: "/alpha.segments/_tree.segment.rsc",
      sourceRel: "alpha.segments/_tree.segment.rsc",
    },
  ]);
});

test("onBuildComplete maps Pages Router static index HTML to root route", async () => {
  const root = tempDir("pages-static-index");
  const distDir = path.join(root, ".next");
  const indexHtml = path.join(distDir, "server", "pages", "index.html");
  fs.mkdirSync(path.dirname(indexHtml), { recursive: true });
  fs.writeFileSync(indexHtml, "<!doctype html><main>home</main>", "utf8");

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
      appPages: [],
      appRoutes: [],
      pagesApi: [],
      prerenders: [],
      staticFiles: [
        {
          id: "/index",
          pathname: "/index",
          filePath: indexHtml,
        },
      ],
    },
    projectDir: root,
    repoRoot: root,
    distDir,
    config: {},
    nextVersion: "16.3.0-canary.58",
    buildId: "test-build",
  });

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.routes.find((route) => route.id === "static-index"),
    {
      id: "static-index",
      pattern: "^/$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/index",
      immutable: false,
    },
  );
  assert.deepEqual(
    manifest.artifacts.find((artifact) => artifact.id === "static:index"),
    {
      id: "static:index",
      kind: "static",
      ownerRouteId: "static-index",
      sourcePath: ".next/server/pages/index.html",
      packagePath: "static/index",
      mountPath: "/",
      immutable: false,
      required: true,
      reason: "Next Adapter API staticFiles output",
    },
  );
  assert.equal(
    fs.readFileSync(
      path.join(root, "dist", "brrrd", "static", "_next", "data", "test-build", "index.json"),
      "utf8",
    ),
    JSON.stringify({ pageProps: {} }),
  );
  assert.deepEqual(
    manifest.routes.find((route) => route.id === "pages-static-data-index"),
    {
      id: "pages-static-data-index",
      pattern: "^/_next/data/test-build/index\\.json$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/_next/data/test-build/index.json",
    },
  );
  assert.deepEqual(
    manifest.artifacts.find((artifact) => artifact.id === "static-data:index"),
    {
      id: "static-data:index",
      kind: "static",
      ownerRouteId: "pages-static-data-index",
      packagePath: "static/_next/data/test-build/index.json",
      mountPath: "/_next/data/test-build/index.json",
      contentType: "application/json",
      required: true,
      reason: "Pages Router auto-export data JSON generated for client navigation",
    },
  );
});

test("onBuildComplete stores parent static HTML under index when child paths need a directory", async () => {
  const root = tempDir("pages-static-parent-child");
  const distDir = path.join(root, ".next");
  const parentHtml = path.join(distDir, "server", "pages", "[post].html");
  const childHtml = path.join(distDir, "server", "pages", "[post]", "comments.html");
  fs.mkdirSync(path.dirname(parentHtml), { recursive: true });
  fs.mkdirSync(path.dirname(childHtml), { recursive: true });
  fs.writeFileSync(parentHtml, "<!doctype html><main>post</main>", "utf8");
  fs.writeFileSync(childHtml, "<!doctype html><main>comments</main>", "utf8");

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
      appPages: [],
      appRoutes: [],
      pagesApi: [],
      prerenders: [],
      staticFiles: [
        {
          id: "/[post]",
          pathname: "/[post]",
          filePath: parentHtml,
        },
        {
          id: "/[post]/comments",
          pathname: "/[post]/comments",
          filePath: childHtml,
        },
      ],
    },
    projectDir: root,
    repoRoot: root,
    distDir,
    config: {},
    nextVersion: "16.3.0-canary.58",
    buildId: "test-build",
  });

  assert.equal(
    fs.readFileSync(path.join(root, "dist", "brrrd", "static", "[post]", "index"), "utf8"),
    "<!doctype html><main>post</main>",
  );
  assert.equal(
    fs.readFileSync(path.join(root, "dist", "brrrd", "static", "[post]", "comments"), "utf8"),
    "<!doctype html><main>comments</main>",
  );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.routes.find((route) => route.id === "static-_post_"),
    {
      id: "static-_post_",
      pattern: "^\\/([^/]+?)(?:\\/)?$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/[post]/index",
      immutable: false,
      headers: [{ key: "content-type", value: "text/html; charset=utf-8" }],
      params: ["post"],
      paramTypes: { post: "single" },
    },
  );
  assert.deepEqual(
    manifest.artifacts.find((artifact) => artifact.id === "static:_post_").packagePath,
    "static/[post]/index",
  );
});

test("onBuildComplete resolves Pages Router prerender HTML from server/pages", async () => {
  const root = tempDir("pages-prerender-html");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  const gspHtml = path.join(distDir, "server", "pages", "gsp.html");
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('dynamic fallback'); }\n",
    "utf8",
  );
  fs.mkdirSync(path.dirname(gspHtml), { recursive: true });
  fs.writeFileSync(gspHtml, "<!doctype html><main>gsp</main>", "utf8");

  const context = minimalContext(root, distDir, {
    id: "/gsp",
    pathname: "/gsp",
    filePath: handler,
    assets: {},
  });
  context.outputs.appPages = [];
  context.outputs.pages = [
    {
      id: "/gsp",
      pathname: "/gsp",
      filePath: handler,
      assets: {},
    },
  ];
  context.outputs.prerenders = [
    {
      id: "/gsp",
      pathname: "/gsp",
    },
  ];

  await onBuildComplete(context);

  assert.equal(
    fs.readFileSync(path.join(root, "dist", "brrrd", "static", "gsp"), "utf8"),
    "<!doctype html><main>gsp</main>",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.artifacts.find((artifact) => artifact.id === "prerender:gsp").sourcePath,
    ".next/server/pages/gsp.html",
  );
});

test("onBuildComplete packages Pages Router dynamic SSG fallback shells", async () => {
  const root = tempDir("pages-dynamic-fallback-html");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  const fallbackHtml = path.join(distDir, "server", "pages", "[slug].html");
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('dynamic fallback'); }\n",
    "utf8",
  );
  fs.mkdirSync(path.dirname(fallbackHtml), { recursive: true });
  fs.writeFileSync(fallbackHtml, "<!doctype html><main>fallback shell</main>", "utf8");
  writeJson(path.join(distDir, "prerender-manifest.json"), {
    dynamicRoutes: {
      "/[slug]": {
        routeRegex: "^/([^/]+?)(?:/)?$",
        dataRouteRegex: "^/_next/data/test\\-build/([^/]+?)\\.json$",
        fallback: "/[slug].html",
      },
    },
  });

  const context = minimalContext(root, distDir, {
    id: "/",
    pathname: "/",
    filePath: path.join(root, "unused.js"),
    assets: {},
  });
  context.outputs.appPages = [];
  context.outputs.pages = [
    {
      id: "/[slug]",
      pathname: "/[slug]",
      filePath: handler,
      assets: {},
    },
  ];

  await onBuildComplete(context);

  assert.equal(
    fs.readFileSync(path.join(root, "dist", "brrrd", "static", "[slug]"), "utf8"),
    "<!doctype html><main>fallback shell</main>",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.routes.find((route) => route.id === "prerender-fallback-_slug_"),
    {
      id: "prerender-fallback-_slug_",
      pattern: "^/([^/]+?)(?:/)?$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/[slug]",
      headers: [{ key: "content-type", value: "text/html; charset=utf-8" }],
      pagesFallbackShell: true,
    },
  );
  assert.deepEqual(
    manifest.artifacts.find((artifact) => artifact.id === "prerender-fallback:_slug_"),
    {
      id: "prerender-fallback:_slug_",
      kind: "prerender",
      ownerRouteId: "prerender-fallback-_slug_",
      sourcePath: ".next/server/pages/[slug].html",
      packagePath: "static/[slug]",
      mountPath: "/[slug]",
      contentType: "text/html; charset=utf-8",
      required: true,
      reason: "Pages Router dynamic SSG fallback shell served before invoking the handler",
    },
  );
});

test("onBuildComplete avoids fallback shell storage collisions with public children", async () => {
  const root = tempDir("pages-dynamic-fallback-html-child");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  const fallbackHtml = path.join(distDir, "server", "pages", "blog", "[post].html");
  const childHtml = path.join(root, "child.html");
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('dynamic fallback'); }\n",
    "utf8",
  );
  fs.mkdirSync(path.dirname(fallbackHtml), { recursive: true });
  fs.writeFileSync(fallbackHtml, "<!doctype html><main>fallback shell</main>", "utf8");
  fs.writeFileSync(childHtml, "<!doctype html><main>child</main>", "utf8");
  writeJson(path.join(distDir, "prerender-manifest.json"), {
    dynamicRoutes: {
      "/blog/[post]": {
        routeRegex: "^/blog/([^/]+?)(?:/)?$",
        dataRouteRegex: "^/_next/data/test\\-build/blog/([^/]+?)\\.json$",
        fallback: "/blog/[post].html",
      },
    },
  });

  const context = minimalContext(root, distDir, {
    id: "/",
    pathname: "/",
    filePath: path.join(root, "unused.js"),
    assets: {},
  });
  context.outputs.appPages = [];
  context.outputs.pages = [
    {
      id: "/blog/[post]",
      pathname: "/blog/[post]",
      filePath: handler,
      assets: {},
    },
  ];
  context.outputs.staticFiles = [
    {
      id: "/blog/[post]/comments",
      pathname: "/blog/[post]/comments",
      urlPath: "/blog/[post]/comments",
      filePath: childHtml,
      assets: {},
    },
  ];

  await onBuildComplete(context);

  assert.equal(
    fs.readFileSync(path.join(root, "dist", "brrrd", "static", "blog", "[post]", "index"), "utf8"),
    "<!doctype html><main>fallback shell</main>",
  );
  assert.equal(
    fs.readFileSync(path.join(root, "dist", "brrrd", "static", "blog", "[post]", "comments"), "utf8"),
    "<!doctype html><main>child</main>",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.routes.find((route) => route.id === "prerender-fallback-blog-_post_")?.file,
    "/blog/[post]/index",
  );
  assert.equal(
    manifest.artifacts.find((artifact) => artifact.id === "prerender-fallback:blog-_post_")?.packagePath,
    "static/blog/[post]/index",
  );
});

test("onBuildComplete resolves Pages Router basePath prerender HTML from unprefixed server/pages", async () => {
  const root = tempDir("pages-basepath-prerender-html");
  const distDir = path.join(root, ".next");
  const handler = path.join(distDir, "server", "pages", "gsp.js");
  const gspHtml = path.join(distDir, "server", "pages", "gsp.html");
  fs.mkdirSync(path.dirname(gspHtml), { recursive: true });
  fs.writeFileSync(handler, "export default function Page() {}\n", "utf8");
  fs.writeFileSync(gspHtml, "<!doctype html><main>base gsp</main>", "utf8");

  const context = minimalContext(root, distDir, {
    id: "/",
    pathname: "/",
    filePath: path.join(root, "unused.js"),
    assets: {},
  });
  context.config = { basePath: "/base" };
  context.outputs.appPages = [];
  context.outputs.pages = [
    {
      id: "/base/gsp",
      pathname: "/base/gsp",
      filePath: handler,
      assets: {},
    },
  ];
  context.outputs.prerenders = [
    {
      id: "/base/gsp",
      pathname: "/base/gsp",
    },
  ];

  await onBuildComplete(context);

  assert.equal(
    fs.readFileSync(path.join(root, "dist", "brrrd", "static", "base", "gsp"), "utf8"),
    "<!doctype html><main>base gsp</main>",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.artifacts.find((artifact) => artifact.id === "prerender:base-gsp"),
    {
      id: "prerender:base-gsp",
      kind: "prerender",
      ownerRouteId: "prerender-base-gsp",
      sourcePath: ".next/server/pages/gsp.html",
      packagePath: "static/base/gsp",
      mountPath: "/base/gsp",
      contentType: "text/html; charset=utf-8",
      required: true,
      reason: "static prerender HTML served without invoking the handler",
    },
  );
});

test("onBuildComplete resolves App Router basePath prerender HTML from unprefixed server/app", async () => {
  const root = tempDir("app-basepath-prerender-html");
  const distDir = path.join(root, ".next");
  const handler = path.join(distDir, "server", "app", "another", "page.js");
  const html = path.join(distDir, "server", "app", "another.html");
  fs.mkdirSync(path.dirname(html), { recursive: true });
  fs.mkdirSync(path.dirname(handler), { recursive: true });
  fs.writeFileSync(handler, "export default function Page() {}\n", "utf8");
  fs.writeFileSync(html, "<!doctype html><main>base app</main>", "utf8");

  const context = minimalContext(root, distDir, {
    id: "/another",
    pathname: "/base/another",
    filePath: handler,
    sourcePage: "/another/page",
    assets: {},
  });
  context.config = { basePath: "/base" };
  context.outputs.prerenders = [
    {
      id: "/another",
      pathname: "/base/another",
    },
  ];

  await onBuildComplete(context);

  assert.equal(
    fs.readFileSync(path.join(root, "dist", "brrrd", "static", "base", "another"), "utf8"),
    "<!doctype html><main>base app</main>",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.artifacts.find((artifact) => artifact.id === "prerender:base-another"),
    {
      id: "prerender:base-another",
      kind: "prerender",
      ownerRouteId: "prerender-base-another",
      sourcePath: ".next/server/app/another.html",
      packagePath: "static/base/another",
      mountPath: "/base/another",
      contentType: "text/html; charset=utf-8",
      required: true,
      reason: "static prerender HTML served without invoking the handler",
    },
  );
});

test("onBuildComplete resolves Pages Router prerender data JSON from server/pages", async () => {
  const root = tempDir("pages-prerender-data-json");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  const dataJson = path.join(distDir, "server", "pages", "gsp.json");
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('dynamic fallback'); }\n",
    "utf8",
  );
  fs.mkdirSync(path.dirname(dataJson), { recursive: true });
  fs.writeFileSync(dataJson, JSON.stringify({ pageProps: { from: "gsp" } }), "utf8");

  const context = minimalContext(root, distDir, {
    id: "/gsp",
    pathname: "/gsp",
    filePath: handler,
    assets: {},
  });
  context.outputs.appPages = [];
  context.outputs.pages = [
    {
      id: "/gsp",
      pathname: "/gsp",
      filePath: handler,
      assets: {},
    },
  ];
  context.outputs.prerenders = [
    {
      id: "/_next/data/test-build/gsp.json",
      pathname: "/_next/data/test-build/gsp.json",
    },
  ];

  await onBuildComplete(context);

  assert.equal(
    fs.readFileSync(
      path.join(root, "dist", "brrrd", "static", "_next", "data", "test-build", "gsp.json"),
      "utf8",
    ),
    JSON.stringify({ pageProps: { from: "gsp" } }),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.artifacts.find((artifact) => (
      artifact.id === "prerender:_next-data-test-build-gsp_json"
    )),
    {
      id: "prerender:_next-data-test-build-gsp_json",
      kind: "prerender",
      ownerRouteId: "prerender-_next-data-test-build-gsp_json",
      sourcePath: ".next/server/pages/gsp.json",
      packagePath: "static/_next/data/test-build/gsp.json",
      mountPath: "/_next/data/test-build/gsp.json",
      contentType: "application/json",
      required: true,
      reason: "Pages Router prerender data JSON served without invoking the handler",
    },
  );
});

test("onBuildComplete skips dynamic prerender template data artifacts", async () => {
  const root = tempDir("pages-dynamic-prerender-template-data");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "pages", "api-docs", "[...slug].js");
  const literalDataJson = path.join(distDir, "server", "pages", "api-docs", "[first].json");
  fs.mkdirSync(path.dirname(handler), { recursive: true });
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('dynamic api docs'); }\n",
    "utf8",
  );
  fs.mkdirSync(path.dirname(literalDataJson), { recursive: true });
  fs.writeFileSync(
    literalDataJson,
    JSON.stringify({ pageProps: { slug: "[first]" } }),
    "utf8",
  );
  writeJson(path.join(distDir, "prerender-manifest.json"), {
    version: 4,
    routes: {},
    dynamicRoutes: {
      "/api-docs/[...slug]": {
        routeRegex: "^/api-docs/(.+?)(?:/)?$",
        dataRoute: "/_next/data/test-build/api-docs/[...slug].json",
        dataRouteRegex: "^/_next/data/test-build/api-docs/(.+?)\\.json$",
        fallback: false,
      },
    },
  });

  const context = minimalContext(root, distDir, {
    id: "/api-docs/[...slug]",
    pathname: "/api-docs/[...slug]",
    filePath: handler,
    assets: {},
  });
  context.outputs.appPages = [];
  context.outputs.pages = [
    {
      id: "/api-docs/[...slug]",
      pathname: "/api-docs/[...slug]",
      filePath: handler,
      assets: {},
    },
  ];
  context.outputs.prerenders = [
    {
      id: "/_next/data/test-build/api-docs/[...slug].json",
      pathname: "/_next/data/test-build/api-docs/[...slug].json",
    },
    {
      id: "/_next/data/test-build/api-docs/[first].json",
      pathname: "/_next/data/test-build/api-docs/[first].json",
    },
  ];

  await onBuildComplete(context);

  assert.equal(
    fs.readFileSync(
      path.join(root, "dist", "brrrd", "static", "_next", "data", "test-build", "api-docs", "[first].json"),
      "utf8",
    ),
    JSON.stringify({ pageProps: { slug: "[first]" } }),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.artifacts.some((artifact) => (
      artifact.id === "prerender:_next-data-test-build-api-docs-___slug__json"
    )),
    false,
  );
});

test("onBuildComplete resolves Pages Router basePath prerender data JSON from unprefixed server/pages", async () => {
  const root = tempDir("pages-basepath-prerender-data-json");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  const dataJson = path.join(distDir, "server", "pages", "gsp.json");
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('dynamic fallback'); }\n",
    "utf8",
  );
  fs.mkdirSync(path.dirname(dataJson), { recursive: true });
  fs.writeFileSync(dataJson, JSON.stringify({ pageProps: { from: "base gsp" } }), "utf8");

  const context = minimalContext(root, distDir, {
    id: "/base/gsp",
    pathname: "/base/gsp",
    filePath: handler,
    assets: {},
  });
  context.config = { basePath: "/base" };
  context.outputs.appPages = [];
  context.outputs.pages = [
    {
      id: "/base/gsp",
      pathname: "/base/gsp",
      filePath: handler,
      assets: {},
    },
  ];
  context.outputs.prerenders = [
    {
      id: "/base/_next/data/test-build/gsp.json",
      pathname: "/base/_next/data/test-build/gsp.json",
    },
  ];

  await onBuildComplete(context);

  assert.equal(
    fs.readFileSync(
      path.join(root, "dist", "brrrd", "static", "base", "_next", "data", "test-build", "gsp.json"),
      "utf8",
    ),
    JSON.stringify({ pageProps: { from: "base gsp" } }),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.artifacts.find((artifact) => (
      artifact.id === "prerender:base-_next-data-test-build-gsp_json"
    )),
    {
      id: "prerender:base-_next-data-test-build-gsp_json",
      kind: "prerender",
      ownerRouteId: "prerender-base-_next-data-test-build-gsp_json",
      sourcePath: ".next/server/pages/gsp.json",
      packagePath: "static/base/_next/data/test-build/gsp.json",
      mountPath: "/base/_next/data/test-build/gsp.json",
      contentType: "application/json",
      required: true,
      reason: "Pages Router prerender data JSON served without invoking the handler",
    },
  );
});

test("onBuildComplete does not materialize route handler prerenders as page HTML", async () => {
  const root = tempDir("app-route-prerender");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "routes", "[dyn]", "route.js");
  fs.mkdirSync(path.dirname(handler), { recursive: true });
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('route handler'); }\n",
    "utf8",
  );

  await onBuildComplete({
    routing: {
      beforeMiddleware: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [
        {
          source: "/routes/[dyn]",
          sourceRegex: "^/routes/([^/]+?)(?:/)?$",
          destination: "/routes/[dyn]",
        },
      ],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: null,
    },
    outputs: {
      pages: [],
      appPages: [],
      appRoutes: [
        {
          id: "/routes/[dyn]/route",
          pathname: "/routes/[dyn]",
          filePath: handler,
          assets: {},
        },
      ],
      pagesApi: [],
      prerenders: [
        {
          id: "/routes/1",
          pathname: "/routes/1",
          parentOutputId: "/routes/[dyn]/route",
        },
      ],
      staticFiles: [],
    },
    projectDir: root,
    repoRoot: root,
    distDir,
    config: {},
    nextVersion: "16.3.0-canary.58",
    buildId: "test-build",
  });

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.artifacts.some((artifact) => artifact.id === "prerender:routes-1"),
    false,
  );
  assert.equal(
    manifest.routes.some((route) => route.id === "prerender-routes-1"),
    false,
  );
  assert.deepEqual(
    manifest.routes.find((route) => route.id === "routes-_dyn_-route"),
    {
      id: "routes-_dyn_-route",
      pattern: "^/routes/([^/]+?)(?:/)?$",
      type: "route",
      runtime: "nodejs",
      params: ["dyn"],
      paramTypes: { dyn: "single" },
    },
  );
});

test("onBuildComplete preserves static route handler prerender response metadata", async () => {
  const root = tempDir("static-route-handler-prerender-meta");
  const distDir = path.join(root, ".next");
  const bodyPath = path.join(distDir, "server", "app", "manifest.webmanifest.body");
  fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
  fs.writeFileSync(bodyPath, JSON.stringify({ name: "brrrd" }), "utf8");
  writeJson(path.join(distDir, "prerender-manifest.json"), {
    routes: {
      "/manifest.webmanifest": {
        srcRoute: "/manifest.webmanifest",
        dataRoute: null,
        initialHeaders: {
          "cache-control": "public, max-age=0, must-revalidate",
          "content-type": "application/manifest+json",
        },
      },
    },
    dynamicRoutes: {},
  });

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
      appPages: [],
      appRoutes: [],
      pagesApi: [],
      prerenders: [],
      staticFiles: [
        {
          id: "/manifest.webmanifest",
          pathname: "/manifest.webmanifest",
          filePath: bodyPath,
        },
      ],
    },
    projectDir: root,
    repoRoot: root,
    distDir,
    config: {},
    nextVersion: "16.3.0-canary.59",
    buildId: "test-build",
  });

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.routes.find((route) => route.id === "static-manifest_webmanifest"),
    {
      id: "static-manifest_webmanifest",
      pattern: "^/manifest\\.webmanifest$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/manifest.webmanifest",
      immutable: false,
      headers: [
        { key: "cache-control", value: "public, max-age=0, must-revalidate" },
        { key: "content-type", value: "application/manifest+json" },
      ],
    },
  );
  assert.deepEqual(
    manifest.artifacts.find((artifact) => artifact.id === "static:manifest_webmanifest"),
    {
      id: "static:manifest_webmanifest",
      kind: "static",
      ownerRouteId: "static-manifest_webmanifest",
      sourcePath: ".next/server/app/manifest.webmanifest.body",
      packagePath: "static/manifest.webmanifest",
      mountPath: "/manifest.webmanifest",
      contentType: "application/manifest+json",
      immutable: false,
      required: true,
      reason: "Next Adapter API staticFiles output",
    },
  );
});

test("onBuildComplete preserves exact route precedence after trailingSlash redirect", async () => {
  const root = tempDir("trailing-slash-exact-routes");
  const distDir = path.join(root, ".next");
  const loginHandler = path.join(root, "pages", "api", "user", "login.js");
  const dynamicHandler = path.join(root, "pages", "api", "user", "[id].js");
  const helloHandler = path.join(root, "pages", "hello.js");
  for (const handler of [loginHandler, dynamicHandler, helloHandler]) {
    fs.mkdirSync(path.dirname(handler), { recursive: true });
    fs.writeFileSync(handler, "export function handler(_req, res) { res.end('ok'); }\n", "utf8");
  }

  await onBuildComplete({
    routing: {
      beforeMiddleware: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [
        {
          source: "/api/user/[id]",
          sourceRegex: "^/api/user/([^/]+?)(?:/)?$",
          destination: "/api/user/[id]",
        },
      ],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: null,
    },
    outputs: {
      pages: [{
        id: "/hello",
        pathname: "/hello",
        filePath: helloHandler,
        assets: {},
      }],
      appPages: [],
      appRoutes: [],
      pagesApi: [
        {
          id: "/api/user/login",
          pathname: "/api/user/login",
          filePath: loginHandler,
          assets: {},
        },
        {
          id: "/api/user/[id]",
          pathname: "/api/user/[id]",
          filePath: dynamicHandler,
          assets: {},
        },
      ],
      prerenders: [],
      staticFiles: [],
    },
    projectDir: root,
    repoRoot: root,
    distDir,
    config: { trailingSlash: true },
    nextVersion: "16.3.0-canary.58",
    buildId: "test-build",
  });

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.routes.find((route) => route.id === "api-user-login").pattern,
    "^/api/user/login(?:/)?$",
  );
  assert.equal(
    manifest.routes.find((route) => route.id === "hello").pattern,
    "^/hello(?:/)?$",
  );
  assert.equal(
    manifest.routes.find((route) => route.id === "api-user-_id_").pattern,
    "^/api/user/([^/]+?)(?:/)?$",
  );
});

test("onBuildComplete copies traced route runtime files from .next", async () => {
  const root = tempDir("route-runtime-files");
  const distDir = path.join(root, ".next");
  const handler = path.join(distDir, "server", "pages", "404.js");
  const chunk = path.join(distDir, "server", "chunks", "ssr", "chunk.js");
  const assetModule = path.join(
    distDir,
    "server",
    "chunks",
    "static",
    "media",
    "my-data.1234.json",
  );
  const projectAsset = path.join(root, "assets", "typewr__.ttf");
  const routeManifest = path.join(distDir, "server", "pages", "404", "react-loadable-manifest.json");
  fs.mkdirSync(path.dirname(handler), { recursive: true });
  fs.mkdirSync(path.dirname(chunk), { recursive: true });
  fs.mkdirSync(path.dirname(assetModule), { recursive: true });
  fs.mkdirSync(path.dirname(projectAsset), { recursive: true });
  fs.mkdirSync(path.dirname(routeManifest), { recursive: true });
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('404'); }\n",
    "utf8",
  );
  fs.writeFileSync(`${handler}.nft.json`, JSON.stringify({
    version: 1,
    files: [
      "../chunks/ssr/chunk.js",
      "../chunks/static/media/my-data.1234.json",
      "./404/react-loadable-manifest.json",
    ],
  }), "utf8");
  fs.writeFileSync(chunk, "module.exports = [];\n", "utf8");
  fs.writeFileSync(assetModule, "{\"message\":\"hello\"}\n", "utf8");
  fs.writeFileSync(projectAsset, "font-bytes", "utf8");
  fs.writeFileSync(routeManifest, "{}", "utf8");

  const context = minimalContext(root, distDir, {
    id: "/404",
    pathname: "/404",
    filePath: handler,
    assets: {
      "server/chunks/static/media/my-data.1234.json": assetModule,
      "assets/typewr__.ttf": projectAsset,
    },
  });
  context.outputs.appPages = [];
  context.outputs.pages = [
    {
      id: "/404",
      pathname: "/404",
      filePath: handler,
      assets: {
        "server/chunks/static/media/my-data.1234.json": assetModule,
        "assets/typewr__.ttf": projectAsset,
      },
    },
  ];

  await onBuildComplete(context);

  assert.equal(
    fs.readFileSync(
      path.join(root, "dist", "brrrd", "runtime", ".next", "server", "chunks", "ssr", "chunk.js"),
      "utf8",
    ),
    "module.exports = [];\n",
  );
  assert.equal(
    fs.readFileSync(
      path.join(
        root,
        "dist",
        "brrrd",
        "runtime",
        ".next",
        "server",
        "pages",
        "404",
        "react-loadable-manifest.json",
      ),
      "utf8",
    ),
    "{}",
  );
  assert.equal(
    fs.readFileSync(
      path.join(
        root,
        "dist",
        "brrrd",
        "runtime",
        "chunks",
        "static",
        "media",
        "my-data.1234.json",
      ),
      "utf8",
    ),
    "{\"message\":\"hello\"}\n",
  );
  assert.equal(
    fs.readFileSync(
      path.join(root, "dist", "brrrd", "runtime", "assets", "typewr__.ttf"),
      "utf8",
    ),
    "font-bytes",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.artifacts.filter((artifact) =>
      artifact.packagePath === "runtime/.next/server/chunks/ssr/chunk.js"
    ).length,
    1,
  );
  assert.equal(
    manifest.artifacts.some((artifact) =>
      artifact.packagePath === "runtime/chunks/static/media/my-data.1234.json"
        && artifact.mountPath === "chunks/static/media/my-data.1234.json"
        && artifact.reason === "Next traced route runtime dependency for app bundle runtime chunk URL"
    ),
    true,
  );
  assert.equal(
    manifest.artifacts.some((artifact) =>
      artifact.packagePath === "runtime/assets/typewr__.ttf"
        && artifact.mountPath === "assets/typewr__.ttf"
        && artifact.reason === "Next traced route runtime dependency for project-relative server asset"
    ),
    true,
  );
});

test("onBuildComplete copies App Route project-relative traced assets into runtime fs", async () => {
  const root = tempDir("app-route-project-assets");
  const distDir = path.join(root, ".next");
  const handler = path.join(distDir, "server", "app", "font", "opengraph-image2", "route.js");
  const projectAsset = path.join(root, "assets", "typewr__.ttf");
  fs.mkdirSync(path.dirname(handler), { recursive: true });
  fs.mkdirSync(path.dirname(projectAsset), { recursive: true });
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('image'); }\n",
    "utf8",
  );
  fs.writeFileSync(projectAsset, "font-bytes", "utf8");

  const context = minimalContext(root, distDir, {
    id: "/",
    pathname: "/",
    filePath: path.join(distDir, "server", "app", "page.js"),
    assets: {},
  });
  fs.writeFileSync(context.outputs.appPages[0].filePath, "export function handler() {}\n", "utf8");
  context.outputs.appRoutes = [
    {
      id: "/font/opengraph-image2",
      pathname: "/font/opengraph-image2",
      filePath: handler,
      runtime: "nodejs",
      sourcePage: "/font/opengraph-image2/route",
      assets: {
        "assets/typewr__.ttf": projectAsset,
      },
    },
  ];

  await onBuildComplete(context);

  assert.equal(
    fs.readFileSync(
      path.join(root, "dist", "brrrd", "runtime", "assets", "typewr__.ttf"),
      "utf8",
    ),
    "font-bytes",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.artifacts.some((artifact) =>
      artifact.ownerRouteId === "font-opengraph-image2"
        && artifact.packagePath === "runtime/assets/typewr__.ttf"
        && artifact.mountPath === "assets/typewr__.ttf"
        && artifact.reason === "Next traced route runtime dependency for project-relative server asset"
    ),
    true,
  );
});

test("onBuildComplete copies untraced Next server chunk graph files", async () => {
  const root = tempDir("server-chunk-graph");
  const distDir = path.join(root, ".next");
  const handler = path.join(distDir, "server", "pages", "404.js");
  const untracedChunk = path.join(
    distDir,
    "server",
    "chunks",
    "ssr",
    "template-page.js",
  );
  fs.mkdirSync(path.dirname(handler), { recursive: true });
  fs.mkdirSync(path.dirname(untracedChunk), { recursive: true });
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('404'); }\n",
    "utf8",
  );
  fs.writeFileSync(`${handler}.nft.json`, JSON.stringify({
    version: 1,
    files: [],
  }), "utf8");
  fs.writeFileSync(untracedChunk, "module.exports = 'dynamic chunk';\n", "utf8");

  const context = minimalContext(root, distDir, {
    id: "/404",
    pathname: "/404",
    filePath: handler,
    assets: {},
  });
  context.outputs.appPages = [];
  context.outputs.pages = [
    {
      id: "/404",
      pathname: "/404",
      filePath: handler,
      assets: {},
    },
  ];

  await onBuildComplete(context);

  const packagePath = path.join(
    root,
    "dist",
    "brrrd",
    "runtime",
    ".next",
    "server",
    "chunks",
    "ssr",
    "template-page.js",
  );
  assert.equal(
    fs.readFileSync(packagePath, "utf8"),
    "module.exports = 'dynamic chunk';\n",
  );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.artifacts.some((artifact) =>
      artifact.packagePath === "runtime/.next/server/chunks/ssr/template-page.js"
        && artifact.reason === "Next server runtime chunk graph"
    ),
    true,
  );
});

test("onBuildComplete vendors traced node_modules runtime externals", async () => {
  const root = tempDir("node-runtime-externals");
  const distDir = path.join(root, ".next");
  const handler = path.join(distDir, "server", "pages", "404.js");
  const external = path.join(
    root,
    "node_modules",
    ".pnpm",
    "next@16.3.0",
    "node_modules",
    "next",
    "dist",
    "compiled",
    "next-server",
    "pages-turbo.runtime.prod.js",
  );
  fs.mkdirSync(path.dirname(handler), { recursive: true });
  fs.mkdirSync(path.dirname(external), { recursive: true });
  fs.writeFileSync(
    handler,
    "export function handler(_req, res) { res.end('404'); }\n",
    "utf8",
  );
  fs.writeFileSync(`${handler}.nft.json`, JSON.stringify({
    version: 1,
    files: [
      "../../../node_modules/.pnpm/next@16.3.0/node_modules/next/dist/compiled/next-server/pages-turbo.runtime.prod.js",
    ],
  }), "utf8");
  fs.writeFileSync(external, "module.exports = { runtime: 'pages-turbo' };\n", "utf8");

  const context = minimalContext(root, distDir, {
    id: "/404",
    pathname: "/404",
    filePath: handler,
    assets: {},
  });
  context.outputs.appPages = [];
  context.outputs.pages = [
    {
      id: "/404",
      pathname: "/404",
      filePath: handler,
      assets: {},
    },
  ];

  await onBuildComplete(context);

  assert.equal(
    fs.readFileSync(
      path.join(
        root,
        "dist",
        "brrrd",
        "runtime",
        "node_modules",
        "next",
        "dist",
        "compiled",
        "next-server",
        "pages-turbo.runtime.prod.js",
      ),
      "utf8",
    ),
    "module.exports = { runtime: 'pages-turbo' };\n",
  );
});

test("onBuildComplete patches bundled Turbopack server runtime root", async () => {
  const root = tempDir("turbopack-runtime-root");
  const distDir = path.join(root, ".next");
  const handler = path.join(distDir, "server", "pages", "404.js");
  const ssrRuntime = path.join(distDir, "server", "chunks", "ssr", "[turbopack]_runtime.js");
  const routeRuntime = path.join(distDir, "server", "chunks", "[turbopack]_runtime.js");
  fs.mkdirSync(path.dirname(handler), { recursive: true });
  fs.mkdirSync(path.dirname(ssrRuntime), { recursive: true });
  fs.mkdirSync(path.dirname(routeRuntime), { recursive: true });
  fs.writeFileSync(
    handler,
    [
      'const R = require("../chunks/ssr/[turbopack]_runtime.js");',
      'const R2 = require("../chunks/[turbopack]_runtime.js");',
      "export function handler(_req, res) { res.end(String(R) + String(R2)); }",
    ].join("\n"),
    "utf8",
  );
  const runtimeSource = [
    'var path = require("path");',
    'var relativePathToRuntimeRoot = "../../../..";',
    'var relativePathToDistRoot = "../../../..";',
    "const RUNTIME_ROOT = path.resolve(__filename, relativePathToRuntimeRoot);",
    "const ABSOLUTE_ROOT = path.resolve(__filename, relativePathToDistRoot);",
    "module.exports = { RUNTIME_ROOT, ABSOLUTE_ROOT };",
  ].join("\n");
  fs.writeFileSync(ssrRuntime, runtimeSource, "utf8");
  fs.writeFileSync(routeRuntime, runtimeSource, "utf8");

  const context = minimalContext(root, distDir, {
    id: "/404",
    pathname: "/404",
    filePath: handler,
    assets: {
      ssrRuntime,
      routeRuntime,
    },
  });
  context.outputs.appPages = [];
  context.outputs.pages = [
    {
      id: "/404",
      pathname: "/404",
      filePath: handler,
      assets: {
        ssrRuntime,
        routeRuntime,
      },
    },
  ];

  await onBuildComplete(context);

  const appBundle = fs.readFileSync(
    path.join(root, "dist", "brrrd", "bundles", "app.js"),
    "utf8",
  );
  assert.match(appBundle, /__brrrd_turbopack_runtime_root/);
  assert.equal(
    appBundle.match(/globalThis\.__brrrd_turbopack_runtime_root \|\| path\.resolve/g)?.length,
    2,
  );
  assert.equal(
    appBundle.match(/globalThis\.__brrrd_turbopack_dist_root \|\| path\.resolve/g)?.length,
    2,
  );
});

test("onBuildComplete lets next/og fall back to WASM without traced sharp native files", async () => {
  const root = tempDir("next-og");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  fs.writeFileSync(
    handler,
    'import { ImageResponse } from "next/og"; export function handler() { return new ImageResponse("x"); }',
    "utf8",
  );

  await onBuildComplete(
    minimalContext(root, distDir, {
      id: "/apple-icon",
      pathname: "/apple-icon",
      filePath: handler,
      assets: {
        "next-og": require.resolve("next/dist/compiled/@vercel/og/index.node.js"),
        "sharp-native": path.join(
          root,
          "node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node",
        ),
      },
    }),
  );

  const bundleDir = path.join(root, "dist", "brrrd", "bundles");
  const appBundle = fs.readFileSync(path.join(bundleDir, "app.js"), "utf8");
  assert.match(appBundle, /index\.edge\.js/);
  assert.doesNotMatch(appBundle, /index\.node\.js/);
  assert.doesNotMatch(appBundle, /from "stream"/);
  assert.doesNotMatch(appBundle, /from "fs"/);
});

test("onBuildComplete rewrites Next compiled next/og node entry to edge", async () => {
  const root = tempDir("next-og-compiled-entry");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  fs.writeFileSync(
    handler,
    'export async function handler() { return import("next/dist/compiled/@vercel/og/index.node.js"); }',
    "utf8",
  );

  await onBuildComplete(
    minimalContext(root, distDir, {
      id: "/apple-icon",
      pathname: "/apple-icon",
      filePath: handler,
      assets: {
        "next-og": require.resolve("next/dist/compiled/@vercel/og/index.node.js"),
        "sharp-native": path.join(
          root,
          "node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node",
        ),
      },
    }),
  );

  const appBundle = fs.readFileSync(path.join(root, "dist", "brrrd", "bundles", "app.js"), "utf8");
  assert.match(appBundle, /index\.edge\.js/);
  assert.doesNotMatch(appBundle, /index\.node\.js/);
  assert.doesNotMatch(appBundle, /from "stream"/);
});

test("onBuildComplete rejects direct sharp usage even when next/og is present", async () => {
  const root = tempDir("next-og-direct-sharp");
  const distDir = path.join(root, ".next");
  const handler = path.join(root, "handler.js");
  writeFakeSharpPackage(root);
  fs.writeFileSync(
    handler,
    'import { ImageResponse } from "next/og"; import sharp from "sharp"; export function handler() { sharp; return new ImageResponse("x"); }',
    "utf8",
  );

  await assert.rejects(
    onBuildComplete(
      minimalContext(root, distDir, {
        id: "/apple-icon",
        pathname: "/apple-icon",
        filePath: handler,
        assets: {
          "next-og": require.resolve("next/dist/compiled/@vercel/og/index.node.js"),
          "sharp-native": path.join(
            root,
            "node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node",
          ),
        },
      }),
    ),
    /direct sharp imports must be removed/,
  );
});

test("compileRouting preserves Adapter API routing phases and conditions", () => {
  const root = tempDir("ctx-routing");
  const model = createNextBuildModel({
    ...minimalContext(root, path.join(root, ".next"), {
      id: "/",
      pathname: "/",
      filePath: path.join(root, "handler.js"),
      assets: {},
    }),
    routing: {
      beforeMiddleware: [
        {
          source: "/with-header",
          sourceRegex: "^/with-header$",
          headers: { "x-from-header-rule": "yes" },
        },
        {
          source: "/old",
          sourceRegex: "^/old$",
          destination: "/new",
          status: 308,
          has: [{ type: "host", value: "example.com" }],
        },
      ],
      beforeFiles: [
        {
          source: "/a",
          sourceRegex: "^/a$",
          destination: "/b",
          has: [{ type: "query", key: "modal", value: "1" }],
        },
      ],
      afterFiles: [{ source: "/c", sourceRegex: "^/c$", destination: "/d" }],
      fallback: [
        {
          source: "/:path*",
          sourceRegex: "^/(.*)$",
          destination: "/legacy/:path*",
        },
      ],
    },
  });

  assert.deepEqual(compileRouting(model), {
    headers: [
      {
        regex: "^/with-header$",
        source: "/with-header",
        headers: [{ key: "x-from-header-rule", value: "yes" }],
      },
    ],
    redirects: [
      {
        regex: "^/old$",
        source: "/old",
        destination: "/new",
        statusCode: 308,
        has: [{ type: "host", value: "example.com" }],
      },
    ],
    proxy: null,
    rewrites: {
      beforeFiles: [
        {
          regex: "^/a$",
          source: "/a",
          destination: "/b",
          has: [{ type: "query", key: "modal", value: "1" }],
        },
        {
          regex: "^/_next/data/test-build/a\\.json$",
          source: "/_next/data/test-build/a.json",
          destination: "/_next/data/test-build/b.json",
          has: [{ type: "query", key: "modal", value: "1" }],
        },
      ],
      afterFiles: [
        { regex: "^/c$", source: "/c", destination: "/d" },
        {
          regex: "^/_next/data/test-build/c\\.json$",
          source: "/_next/data/test-build/c.json",
          destination: "/_next/data/test-build/d.json",
        },
      ],
      fallback: [
        { regex: "^/(.*)$", source: "/:path*", destination: "/legacy/:path*" },
        {
          regex: "^/_next/data/test-build/(.*)\\.json$",
          source: "/_next/data/test-build/:path*.json",
          destination: "/_next/data/test-build/legacy/:path*.json",
        },
      ],
    },
  });
});

test("compileRouting emits Pages data rewrite aliases for client transitions", () => {
  const root = tempDir("pages-data-rewrite-alias");
  const model = createNextBuildModel({
    ...minimalContext(root, path.join(root, ".next"), {
      id: "/",
      pathname: "/",
      filePath: path.join(root, "handler.js"),
      assets: {},
    }),
    config: {
      i18n: {
        locales: ["en", "fr", "nl"],
        defaultLocale: "en",
      },
    },
    routing: {
      afterFiles: [{
        source: "/:nextInternalLocale(en|fr|nl)/rewrite-1",
        sourceRegex: "^(?:\\/(en|fr|nl))\\/rewrite-1(?:\\/)?$",
        destination: "/$1/ssr-page?from=config&nextInternalLocale=$1",
      }],
    },
  });

  assert.deepEqual(compileRouting(model).rewrites.afterFiles, [
    {
      regex: "^(?:\\/(en|fr|nl))\\/rewrite-1(?:\\/)?$",
      source: "/:nextInternalLocale(en|fr|nl)/rewrite-1",
      destination: "/$1/ssr-page?from=config&nextInternalLocale=$1",
    },
    {
      regex: "^/_next/data/test-build(?:\\/(en|fr|nl))\\/rewrite-1\\.json$",
      source: "/_next/data/test-build/:nextInternalLocale(en|fr|nl)/rewrite-1.json",
      destination: "/_next/data/test-build/$1/ssr-page.json?from=config&nextInternalLocale=$1",
    },
  ]);
});

test("compileRouting preserves i18n localeDetection false", () => {
  const root = tempDir("i18n-locale-detection");
  const model = createNextBuildModel({
    ...minimalContext(root, path.join(root, ".next"), {
      id: "/",
      pathname: "/",
      filePath: path.join(root, "handler.js"),
      assets: {},
    }),
    config: {
      i18n: {
        locales: ["en", "id"],
        defaultLocale: "en",
        localeDetection: false,
      },
    },
  });

  assert.deepEqual(compileRouting(model).i18n, {
    locales: ["en", "id"],
    defaultLocale: "en",
    localeDetection: false,
  });
});

test("compileRouting preserves Next sourceRegex without lookaround stripping", () => {
  const root = tempDir("lookaround");
  const model = createNextBuildModel({
    ...minimalContext(root, path.join(root, ".next"), {
      id: "/",
      pathname: "/",
      filePath: path.join(root, "handler.js"),
      assets: {},
    }),
    routing: {
      beforeFiles: [{
        source: "/((?!api).*)",
        sourceRegex: "^/((?!api).*)$",
        destination: "/catch/$1",
      }],
    },
  });

  assert.equal(
    compileRouting(model).rewrites.beforeFiles[0].regex,
    "^/((?!api).*)$",
  );
});

test("compileRouting upgrades Adapter API Location headers with redirect supplement", () => {
  const root = tempDir("redirect-supplement");
  const model = createNextBuildModel({
    ...minimalContext(root, path.join(root, ".next"), {
      id: "/",
      pathname: "/",
      filePath: path.join(root, "handler.js"),
      assets: {},
    }),
    routing: {
      beforeMiddleware: [
        {
          source: "/old-about",
          sourceRegex: "^/old-about$",
          headers: { Location: "/about" },
        },
      ],
    },
  });

  assert.deepEqual(compileRouting(model, {
    redirects: [{
      regex: "^/old-about$",
      source: "/old-about",
      destination: "/about",
      statusCode: 308,
    }],
  }), {
    headers: [],
    redirects: [{
      regex: "^/old-about$",
      source: "/old-about",
      destination: "/about",
      statusCode: 308,
    }],
    proxy: null,
    rewrites: {
      beforeFiles: [],
      afterFiles: [],
      fallback: [],
    },
  });
});

test("compileRouting preserves i18n locale-disabled rewrite semantics from routes manifest", () => {
  const root = tempDir("locale-disabled-rewrite");
  const model = createNextBuildModel({
    ...minimalContext(root, path.join(root, ".next"), {
      id: "/",
      pathname: "/",
      filePath: path.join(root, "handler.js"),
      assets: {},
    }),
    config: {
      basePath: "/basepath",
      i18n: {
        locales: ["en", "sv", "nl"],
        defaultLocale: "en",
      },
    },
    routing: {
      beforeFiles: [{
        source: "/:locale/rewrite-files/:path*",
        sourceRegex: "^(?:\\/([^\\/]+?))\\/rewrite-files(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))?(?:\\/)?$",
        destination: "/$2",
      }],
    },
  });

  assert.deepEqual(compileRouting(model, {
    redirects: [],
    rewrites: {
      beforeFiles: [{
        source: "/:locale/rewrite-files/:path*",
        regex: "^(?:\\/([^\\/]+?))\\/rewrite-files(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))?(?:\\/)?$",
        destination: "/$2",
        locale: false,
      }],
      afterFiles: [],
      fallback: [],
    },
  }), {
    basePath: "/basepath",
    i18n: {
      locales: ["en", "sv", "nl"],
      defaultLocale: "en",
      basePath: "/basepath",
    },
    headers: [],
    redirects: [],
    proxy: null,
    rewrites: {
      beforeFiles: [{
        regex: "^(?:\\/([^\\/]+?))\\/rewrite-files(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))?(?:\\/)?$",
        source: "/:locale/rewrite-files/:path*",
        destination: "/$2",
        locale: false,
      }, {
        regex: "^/basepath/_next/data/test-build(?:\\/([^\\/]+?))\\/rewrite-files(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))?\\.json$",
        source: "/basepath/_next/data/test-build/:locale/rewrite-files/:path*.json",
        destination: "/basepath/_next/data/test-build/$2.json",
        locale: false,
      }],
      afterFiles: [],
      fallback: [],
    },
  });
});

test("extractRewriteSupplement preserves locale false per rewrite phase", () => {
  const root = tempDir("rewrite-supplement");
  const distDir = path.join(root, ".next");
  writeJson(path.join(distDir, "routes-manifest.json"), {
    rewrites: {
      beforeFiles: [{
        source: "/:locale/rewrite-files/:path*",
        destination: "/:path*",
        regex: "^(?:/([^/]+?))/rewrite-files(?:/(.*))?$",
        locale: false,
      }],
      afterFiles: [{
        source: "/after",
        destination: "/done",
        regex: "^/after$",
      }],
      fallback: [],
    },
  });

  assert.deepEqual(extractRewriteSupplement(distDir), {
    beforeFiles: [{
      source: "/:locale/rewrite-files/:path*",
      destination: "/:path*",
      regex: "^(?:/([^/]+?))/rewrite-files(?:/(.*))?$",
      locale: false,
    }],
    afterFiles: [{
      source: "/after",
      destination: "/done",
      regex: "^/after$",
    }],
    fallback: [],
  });
});

test("extractStaticRouteSupplement preserves Next static route regexes", () => {
  const root = tempDir("static-route-supplement");
  const distDir = path.join(root, ".next");
  writeJson(path.join(distDir, "routes-manifest.json"), {
    staticRoutes: [
      {
        page: "/router",
        regex: "^/router(?:/)?$",
      },
      {
        page: "/api/user/login",
        regex: "^/api/user/login-fallback$",
        namedRegex: "^/api/user/login(?:/)?$",
      },
      {
        page: "",
        regex: "^/ignored$",
      },
    ],
  });

  assert.deepEqual(
    extractStaticRouteSupplement(distDir),
    [
      {
        page: "/router",
        regex: "^/router(?:/)?$",
      },
      {
        page: "/api/user/login",
        regex: "^/api/user/login(?:/)?$",
      },
    ],
  );
});

test("extractDynamicPrerenderRoutes preserves Next fallback modes", () => {
  const root = tempDir("dynamic-prerender-routes");
  const distDir = path.join(root, ".next");
  writeJson(path.join(distDir, "prerender-manifest.json"), {
    dynamicRoutes: {
      "/[first]": {
        routeRegex: "^/([^/]+?)(?:/)?$",
        dataRoute: "/_next/data/build/[first].json",
        dataRouteRegex: "^/_next/data/build/([^/]+?)\\.json$",
        fallback: false,
        experimentalBypassFor: [
          { type: "header", key: "next-action" },
        ],
      },
      "/[first]/[second]": {
        routeRegex: "^/([^/]+?)/([^/]+?)(?:/)?$",
        fallback: null,
      },
      "/posts/[id]": {
        routeRegex: "^/posts/([^/]+?)(?:/)?$",
        fallback: "/posts/[id].html",
      },
    },
  });

  assert.deepEqual(
    extractDynamicPrerenderRoutes(distDir),
    [
      {
        page: "/[first]",
        routeRegex: "^/([^/]+?)(?:/)?$",
        dataRoute: "/_next/data/build/[first].json",
        dataRouteRegex: "^/_next/data/build/([^/]+?)\\.json$",
        fallback: false,
        bypass: [
          { type: "header", key: "next-action" },
        ],
      },
      {
        page: "/[first]/[second]",
        routeRegex: "^/([^/]+?)/([^/]+?)(?:/)?$",
        fallback: null,
        bypass: [],
      },
      {
        page: "/posts/[id]",
        routeRegex: "^/posts/([^/]+?)(?:/)?$",
        fallback: "/posts/[id].html",
        bypass: [],
      },
    ],
  );
});

test("compileRouting treats status plus Location as redirect only", () => {
  const root = tempDir("status-location-redirect");
  const model = createNextBuildModel({
    ...minimalContext(root, path.join(root, ".next"), {
      id: "/",
      pathname: "/",
      filePath: path.join(root, "handler.js"),
      assets: {},
    }),
    routing: {
      beforeMiddleware: [
        {
          source: "/:path+/",
          sourceRegex: "^(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))\\/$",
          headers: { Location: "/$1" },
          status: 308,
          internal: true,
        },
      ],
    },
  });

  const routing = compileRouting(model);
  assert.deepEqual(routing.headers, []);
  assert.deepEqual(routing.redirects, [{
    regex: "^(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))\\/$",
    source: "/:path+/",
    destination: "/$1",
    statusCode: 308,
    internal: true,
  }]);
});

test("extractMiddlewareMeta rejects multiple middleware entries", () => {
  const distDir = tempDir("multi-middleware");
  writeJson(path.join(distDir, "server", "middleware-manifest.json"), {
    middleware: {
      "/": { files: ["server/edge-runtime-webpack.js", "server/middleware.js"] },
      "/admin": { files: ["server/edge-runtime-webpack.js", "server/admin-middleware.js"] },
    },
  });

  assert.throws(() => extractMiddlewareMeta(distDir), /multiple middleware entries/);
});

test("extractMiddlewareMeta rejects missing referenced files", () => {
  const distDir = tempDir("missing-middleware");
  writeJson(path.join(distDir, "server", "middleware-manifest.json"), {
    middleware: {
      "/": { files: ["server/edge-runtime-webpack.js", "server/middleware.js"] },
    },
  });

  assert.throws(() => extractMiddlewareMeta(distDir), /middleware referenced file missing/);
});

test("extractMiddlewareMeta uses manifest entrypoint for proxy chunks", () => {
  const distDir = tempDir("proxy-entry");
  fs.mkdirSync(path.join(distDir, "server"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "server", "edge-runtime-webpack.js"), "", "utf8");
  fs.writeFileSync(path.join(distDir, "server", "proxy.js"), "", "utf8");
  writeJson(path.join(distDir, "server", "middleware-manifest.json"), {
    middleware: {
      "/": {
        files: ["server/edge-runtime-webpack.js", "server/proxy.js"],
        entrypoint: "server/proxy.js",
        name: "proxy",
        page: "/proxy",
        matchers: [],
      },
    },
  });

  const meta = extractMiddlewareMeta(distDir);
  assert.deepEqual(meta.files, ["server/edge-runtime-webpack.js", "server/proxy.js"]);
  assert.equal(meta.entryRel, "server/proxy.js");
  assert.equal(meta.name, "proxy");
});

test("extractMiddlewareMeta preserves matcher locale flag", () => {
  const distDir = tempDir("middleware-matcher-locale");
  fs.mkdirSync(path.join(distDir, "server"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "server", "edge-runtime-webpack.js"), "", "utf8");
  fs.writeFileSync(path.join(distDir, "server", "middleware.js"), "", "utf8");
  writeJson(path.join(distDir, "server", "middleware-manifest.json"), {
    middleware: {
      "/": {
        files: ["server/edge-runtime-webpack.js", "server/middleware.js"],
        entrypoint: "server/middleware.js",
        name: "middleware",
        page: "/",
        matchers: [{
          regexp: "^/nl-NL/about$",
          originalSource: "/nl-NL/about",
          locale: false,
        }],
      },
    },
  });

  const meta = extractMiddlewareMeta(distDir);
  assert.deepEqual(meta.matchers, [{
    regexp: "^/nl-NL/about$",
    originalSource: "/nl-NL/about",
    locale: false,
  }]);
});

test("extractMiddlewareMeta preserves Turbopack middleware file order", () => {
  const distDir = tempDir("turbopack-middleware");
  const files = [
    "server/edge/chunks/runtime.js",
    "server/edge/chunks/support.js",
    "server/edge/chunks/entry.js",
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(distDir, file)), { recursive: true });
    fs.writeFileSync(path.join(distDir, file), "", "utf8");
  }
  writeJson(path.join(distDir, "server", "middleware-manifest.json"), {
    middleware: {
      "/": {
        files,
        entrypoint: "server/edge/chunks/entry.js",
        name: "middleware",
        page: "/",
        matchers: [],
      },
    },
  });

  const meta = extractMiddlewareMeta(distDir);
  assert.deepEqual(meta.files, files);
  assert.equal(meta.runtimeRel, "server/edge/chunks/runtime.js");
  assert.equal(meta.entryRel, "server/edge/chunks/entry.js");
});
