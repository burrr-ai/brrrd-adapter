import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { modifyConfig } from "../dist/config.js";

const require = createRequire(import.meta.url);

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
      const out = modifyConfig(
        {},
        {
          phase: "phase-production-build",
          nextVersion: "16.3.0-canary.59",
        },
      );

      assert.equal(
        out.cacheHandlers.default,
        require.resolve("@brrrd/adapter/cache-handler"),
      );
      assert.equal(
        out.cacheHandler,
        require.resolve("@brrrd/adapter/cache-handler-legacy"),
      );
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
      const out = modifyConfig(
        {},
        {
          phase: "phase-production-build",
          nextVersion: "16.3.0-canary.59",
        },
      );

      assert.equal(out.cacheHandlers, undefined);
      assert.equal(
        out.cacheHandler,
        require.resolve("@brrrd/adapter/cache-handler-legacy"),
      );
    },
  );
});

test("modifyConfig treats Next's default TURBOPACK=auto build as Turbopack", () => {
  withEnv(
    {
      IS_WEBPACK_TEST: undefined,
      IS_TURBOPACK_TEST: undefined,
      TURBOPACK: "auto",
    },
    () => {
      const out = modifyConfig(
        {},
        {
          phase: "phase-production-build",
          nextVersion: "16.3.0-canary.59",
        },
      );

      assert.equal(out.cacheHandlers, undefined);
      assert.equal(
        out.cacheHandler,
        require.resolve("@brrrd/adapter/cache-handler-legacy"),
      );
    },
  );
});
