import { createRequire } from "node:module";
import type { NextConfigComplete } from "next/dist/server/config-shared.js";

const require = createRequire(import.meta.url);

export function modifyConfig(
  config: NextConfigComplete,
  _ctx: { phase: string; nextVersion: string },
): NextConfigComplete {
  // Modern `cacheHandlers` expects handler objects. The module is safe to import
  // during `next build` and delegates to brrrd cache ops inside the isolate.
  config.cacheHandlers = config.cacheHandlers ?? {};
  if (!config.cacheHandlers.default) {
    try {
      config.cacheHandlers.default = require.resolve("@brrrd/adapter/cache-handler");
    } catch (e) {
      console.warn("[@brrrd/adapter] cache handler auto-register failed:", e);
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
