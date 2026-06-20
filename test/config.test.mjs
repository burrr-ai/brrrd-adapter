import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { detectBuildBundler, modifyConfig } from "../dist/config.js";

function testContext(nextVersion = "16.3.0-canary.59") {
  return {
    phase: "phase-production-build",
    nextVersion,
    projectDir: fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-config-test-")),
  };
}

function supportFile(ctx, variant) {
  return path.join(
    ctx.projectDir,
    "node_modules",
    ".cache",
    "@brrrd",
    "adapter",
    `${variant}.mjs`,
  );
}

function assertMaterialized(filePath) {
  assert.equal(fs.statSync(filePath).isFile(), true);
  assert.match(fs.readFileSync(filePath, "utf8"), /BrrrdCacheHandler|Legacy/);
}

function withEnv(patch, fn) {
  const keys = Object.keys(patch);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withArgv(argv, fn) {
  const previous = process.argv;
  process.argv = argv;
  try {
    return fn();
  } finally {
    process.argv = previous;
  }
}

test("modifyConfig does not downgrade Next image rendering semantics", () => {
  const config = {
    images: {
      domains: ["i.imgur.com"],
      deviceSizes: [1234],
    },
  };

  const out = modifyConfig(config, {
    phase: "phase-production-build",
    nextVersion: "16.3.0-canary.58",
    projectDir: fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-config-test-")),
  });

  assert.equal(out.images.unoptimized, undefined);
  assert.deepEqual(out.images.deviceSizes, [1234]);
});

test("modifyConfig registers modern and legacy cache handlers for webpack builds", () => {
  withEnv(
    {
      IS_WEBPACK_TEST: "1",
      IS_TURBOPACK_TEST: undefined,
      TURBOPACK: undefined,
    },
    () => {
      const ctx = testContext();
      const out = modifyConfig({}, ctx);

      assert.equal(
        out.cacheHandlers.default,
        supportFile(ctx, "cache-handler"),
      );
      assert.equal(
        out.cacheHandler,
        supportFile(ctx, "cache-handler-legacy"),
      );
      assertMaterialized(out.cacheHandlers.default);
      assertMaterialized(out.cacheHandler);
    },
  );
});

test("modifyConfig skips modern cacheHandlers during Turbopack builds", () => {
  withEnv(
    {
      IS_WEBPACK_TEST: undefined,
      IS_TURBOPACK_TEST: "1",
      TURBOPACK: undefined,
    },
    () => {
      const ctx = testContext();
      const out = modifyConfig({}, ctx);

      assert.equal(out.cacheHandlers, undefined);
      assert.equal(
        out.cacheHandler,
        supportFile(ctx, "cache-handler-legacy"),
      );
      assertMaterialized(out.cacheHandler);
    },
  );
});

test("modifyConfig treats TURBOPACK=auto as Turbopack", () => {
  withEnv(
    {
      IS_WEBPACK_TEST: undefined,
      IS_TURBOPACK_TEST: undefined,
      TURBOPACK: "auto",
    },
    () => {
      const ctx = testContext();
      const out = modifyConfig({}, ctx);

      assert.equal(out.cacheHandlers, undefined);
      assert.equal(
        out.cacheHandler,
        supportFile(ctx, "cache-handler-legacy"),
      );
      assertMaterialized(out.cacheHandler);
    },
  );
});

test("modifyConfig treats unqualified Next 16 builds as Turbopack by default", () => {
  withEnv(
    {
      IS_WEBPACK_TEST: undefined,
      IS_TURBOPACK_TEST: undefined,
      TURBOPACK: undefined,
    },
    () =>
      withArgv(["node", "next", "build"], () => {
        assert.equal(
          detectBuildBundler({ nextVersion: "16.3.0-canary.59" }),
          "turbopack",
        );

        const ctx = testContext();
        const out = modifyConfig({}, ctx);

        assert.equal(out.cacheHandlers, undefined);
        assert.equal(
          out.cacheHandler,
          supportFile(ctx, "cache-handler-legacy"),
        );
        assertMaterialized(out.cacheHandler);
      }),
  );
});

test("modifyConfig honors explicit webpack CLI builds on Next 16", () => {
  withEnv(
    {
      IS_WEBPACK_TEST: undefined,
      IS_TURBOPACK_TEST: undefined,
      TURBOPACK: undefined,
    },
    () =>
      withArgv(["node", "next", "build", "--webpack"], () => {
        assert.equal(
          detectBuildBundler({ nextVersion: "16.3.0-canary.59" }),
          "webpack",
        );

        const ctx = testContext();
        const out = modifyConfig({}, ctx);

        assert.equal(
          out.cacheHandlers.default,
          supportFile(ctx, "cache-handler"),
        );
        assert.equal(
          out.cacheHandler,
          supportFile(ctx, "cache-handler-legacy"),
        );
        assertMaterialized(out.cacheHandlers.default);
        assertMaterialized(out.cacheHandler);
      }),
  );
});

test("modifyConfig does not erase user cacheHandlers on Turbopack", () => {
  withEnv(
    {
      IS_WEBPACK_TEST: undefined,
      IS_TURBOPACK_TEST: "1",
      TURBOPACK: undefined,
    },
    () => {
      const existing = { custom: "./custom-cache-handler.js" };
      const ctx = testContext();
      const out = modifyConfig({ cacheHandlers: existing }, ctx);

      assert.equal(out.cacheHandlers, existing);
      assert.equal(out.cacheHandlers.default, undefined);
      assert.equal(
        out.cacheHandler,
        supportFile(ctx, "cache-handler-legacy"),
      );
      assertMaterialized(out.cacheHandler);
    },
  );
});
