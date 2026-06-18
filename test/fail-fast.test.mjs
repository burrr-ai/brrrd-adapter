import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { onBuildComplete } from "../dist/build.js";
import { extractMiddlewareMeta, extractRoutingManifest } from "../dist/manifest.js";

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

function minimalContext(projectDir, distDir, output) {
  return {
    routing: {},
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
  const sharpDir = path.dirname(require.resolve("sharp/package.json", {
    paths: [path.join(process.cwd(), "node_modules/.pnpm/node_modules")],
  }));
  symlinkDir(sharpDir, path.join(root, "node_modules", "sharp"));
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

test("extractRoutingManifest preserves rewrite phases and conditions", () => {
  const distDir = tempDir("before-files");
  writeJson(path.join(distDir, "routes-manifest.json"), {
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

  assert.deepEqual(extractRoutingManifest(distDir), {
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

test("extractRoutingManifest preserves Next regex without lookaround stripping", () => {
  const distDir = tempDir("lookaround");
  writeJson(path.join(distDir, "routes-manifest.json"), {
    rewrites: {
      beforeFiles: [
        {
          regex: "^/((?!api).*)$",
          source: "/((?!api).*)",
          destination: "/catch/$1",
        },
      ],
    },
  });

  assert.equal(
    extractRoutingManifest(distDir).rewrites.beforeFiles[0].regex,
    "^/((?!api).*)$",
  );
});

test("extractRoutingManifest treats array rewrites as afterFiles", () => {
  const distDir = tempDir("array-rewrites");
  writeJson(path.join(distDir, "routes-manifest.json"), {
    redirects: [],
    rewrites: [{ regex: "^/array$", source: "/array", destination: "/target" }],
  });

  assert.deepEqual(extractRoutingManifest(distDir).rewrites, {
    beforeFiles: [],
    afterFiles: [{ regex: "^/array$", source: "/array", destination: "/target" }],
    fallback: [],
  });
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

  assert.throws(() => extractMiddlewareMeta(distDir), /middleware runtime file missing/);
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
  assert.equal(meta.entryRel, "server/proxy.js");
  assert.equal(meta.name, "proxy");
});
