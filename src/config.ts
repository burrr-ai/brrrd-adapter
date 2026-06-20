import { createRequire } from "node:module";
import type { NextConfigComplete } from "next/dist/server/config-shared.js";

const require = createRequire(import.meta.url);

function isTurbopackBuild(): boolean {
  if (process.env.IS_WEBPACK_TEST) {
    return false;
  }
  if (process.env.IS_TURBOPACK_TEST) {
    return true;
  }

  const turbopack = process.env.TURBOPACK?.toLowerCase();
  return Boolean(turbopack && turbopack !== "0" && turbopack !== "false");
}

export function modifyConfig(
  config: NextConfigComplete,
  _ctx: { phase: string; nextVersion: string },
): NextConfigComplete {
  // Modern `cacheHandlers` expects handler objects. The module is safe to import
  // during `next build` and delegates to brrrd cache ops inside the isolate.
  //
  // Next 16.3 canary currently fails Turbopack Edge app-route builds when
  // `cacheHandlers.default` injects cache imports into the edge-app-route
  // template. Keep the legacy ISR handler for Turbopack and let webpack retain
  // the modern handler path.
  if (!isTurbopackBuild()) {
    config.cacheHandlers = config.cacheHandlers ?? {};
    if (!config.cacheHandlers.default) {
      try {
        config.cacheHandlers.default = require.resolve("@brrrd/adapter/cache-handler");
      } catch (e) {
        console.warn("[@brrrd/adapter] cache handler auto-register failed:", e);
      }
    }
  }
  // Legacy IncrementalCache interface — for unstable_cache, fetch revalidate, and page ISR.
  if (!config.cacheHandler) {
    try {
      config.cacheHandler = require.resolve("@brrrd/adapter/cache-handler-legacy");
    } catch (e) {
      console.warn("[@brrrd/adapter] legacy cache handler auto-register failed:", e);
    }
  }

  // Do not set output: 'standalone'.
  // The Adapter API provides per-route output (filePath + assets), so standalone is not needed.

  return config;
}
