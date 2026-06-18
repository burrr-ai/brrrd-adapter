import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { onBuildComplete } from "../dist/build.js";
import { extractMiddlewareMeta, extractRoutingManifest } from "../dist/manifest.js";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `brrrd-adapter-${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
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
