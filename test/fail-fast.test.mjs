import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { onBuildComplete } from "../dist/build.js";
import { extractMiddlewareMeta } from "../dist/manifest-supplement.js";
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

test("onBuildComplete rejects unsupported edge app route outputs", async () => {
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
    /edge app\/page\/api route outputs are not supported/,
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
      params: ["post"],
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
    },
  );
});

test("onBuildComplete copies traced route runtime files from .next", async () => {
  const root = tempDir("route-runtime-files");
  const distDir = path.join(root, ".next");
  const handler = path.join(distDir, "server", "pages", "404.js");
  const chunk = path.join(distDir, "server", "chunks", "ssr", "chunk.js");
  const routeManifest = path.join(distDir, "server", "pages", "404", "react-loadable-manifest.json");
  fs.mkdirSync(path.dirname(handler), { recursive: true });
  fs.mkdirSync(path.dirname(chunk), { recursive: true });
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
      "./404/react-loadable-manifest.json",
    ],
  }), "utf8");
  fs.writeFileSync(chunk, "module.exports = [];\n", "utf8");
  fs.writeFileSync(routeManifest, "{}", "utf8");

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
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "brrrd", "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.artifacts.filter((artifact) =>
      artifact.packagePath === "runtime/.next/server/chunks/ssr/chunk.js"
    ).length,
    1,
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
      ],
      afterFiles: [{ regex: "^/c$", source: "/c", destination: "/d" }],
      fallback: [{ regex: "^/(.*)$", source: "/:path*", destination: "/legacy/:path*" }],
    },
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
