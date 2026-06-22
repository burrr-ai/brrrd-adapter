import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  adapterContextSnapshotEnabled,
  writeAdapterContextSnapshot,
} from "../dist/diagnostics.js";

test("adapterContextSnapshotEnabled follows harness and adapter debug env", () => {
  assert.equal(adapterContextSnapshotEnabled({}), false);
  assert.equal(adapterContextSnapshotEnabled({ BRRRD_HARNESS_CAPTURE_CONTEXT: "1" }), true);
  assert.equal(adapterContextSnapshotEnabled({ BRRRD_ADAPTER_DEBUG_CONTEXT: "true" }), true);
});

test("writeAdapterContextSnapshot persists raw and normalized routing context safely", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-adapter-diags-"));
  const config = { basePath: "/base", webpack() {} };
  config.self = config;
  const ctx = {
    projectDir: "/project",
    repoRoot: "/repo",
    distDir: "/project/.next",
    config,
    nextVersion: "16.3.0-canary.59",
    buildId: "build-1",
    routing: {
      beforeFiles: [{
        source: "/from",
        sourceRegex: "^/from$",
        destination: "/to",
      }],
    },
    outputs: {
      pages: [{
        id: "pages-blog-[slug]",
        pathname: "/_next/data/build-1/blog/[slug].json",
        filePath: "/project/.next/server/pages/blog/[slug].js",
      }],
      appPages: [],
      appRoutes: [],
      pagesApi: [],
      prerenders: [],
      staticFiles: [],
    },
  };
  const model = {
    ...ctx,
    routing: {
      beforeMiddleware: [],
      beforeFiles: ctx.routing.beforeFiles,
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: null,
    },
    outputs: {
      pages: [{
        id: "pages-blog-[slug]",
        pathname: "/_next/data/build-1/blog/[slug].json",
        kind: "page",
        routeKind: "page",
        urlPath: "/blog/[slug]",
        pagesRoutePath: "/blog/[slug]",
        assets: {},
        wasmAssets: {},
        config: {},
      }],
      appPages: [],
      appRoutes: [],
      pagesApi: [],
      prerenders: [],
      staticFiles: [],
    },
  };

  const file = writeAdapterContextSnapshot(dir, ctx, model);
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));

  assert.equal(path.basename(file), "adapter-context.json");
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.config.basePath, "/base");
  assert.equal(snapshot.raw.routing.beforeFiles[0].destination, "/to");
  assert.equal(snapshot.raw.outputs.pages[0].pathname, "/_next/data/build-1/blog/[slug].json");
  assert.equal(snapshot.normalized.outputs.pages[0].pagesRoutePath, "/blog/[slug]");
});
