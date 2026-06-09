import { createRequire } from "node:module";
import type { NextConfigComplete } from "next/dist/server/config-shared.js";

const require = createRequire(import.meta.url);

export function modifyConfig(
  config: NextConfigComplete,
  _ctx: { phase: string; nextVersion: string },
): NextConfigComplete {
  // Disable image optimization (no sharp/squoosh in V8 Isolate)
  config.images = { ...config.images, unoptimized: true };

  // A-6 wiring: auto-register the cache handler polyfill.
  // At build time, require.resolve succeeds against the real disk path of
  // @brrrd/adapter/cache-handler. onBuildComplete also mounts that same file
  // into the isolate at /bundle/brrrd-cache-handler.cjs. At runtime, when Next
  // imports it, brrrd's ModuleLoader (pool.rs::load_bundle_module) looks only at
  // the basename of the absolute disk path and remaps it to
  // /bundle/brrrd-cache-handler.cjs (next step — pool.rs change).
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
