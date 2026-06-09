import { createRequire } from "node:module";
import type { NextConfigComplete } from "next/dist/server/config-shared.js";

const require = createRequire(import.meta.url);

export function modifyConfig(
  config: NextConfigComplete,
  _ctx: { phase: string; nextVersion: string },
): NextConfigComplete {
  // Disable image optimization (no sharp/squoosh in V8 Isolate)
  config.images = { ...config.images, unoptimized: true };

  // A-6 wiring: cache handler 폴리필 자동 등록.
  // build-time 에는 @brrrd/adapter/cache-handler 의 real disk path 로
  // require.resolve 가 성공. 같은 파일을 onBuildComplete 가 isolate 의
  // /bundle/brrrd-cache-handler.cjs 에도 mount. runtime 에 Next 가
  // import 할 때 brrrd 의 ModuleLoader (pool.rs::load_bundle_module) 가
  // 절대 disk path 의 basename 만 보고 /bundle/brrrd-cache-handler.cjs 로
  // remap (다음 단계 — pool.rs 수정).
  config.cacheHandlers = config.cacheHandlers ?? {};
  if (!config.cacheHandlers.default) {
    try {
      config.cacheHandlers.default = require.resolve("@brrrd/adapter/cache-handler");
    } catch (e) {
      console.warn("[@brrrd/adapter] cache handler auto-register failed:", e);
    }
  }
  // Legacy IncrementalCache 인터페이스 — unstable_cache, fetch revalidate, page ISR 용.
  if (!config.cacheHandler) {
    try {
      config.cacheHandler = require.resolve("@brrrd/adapter/cache-handler-legacy");
    } catch (e) {
      console.warn("[@brrrd/adapter] legacy cache handler auto-register failed:", e);
    }
  }

  // output: 'standalone'은 설정하지 않음.
  // Adapter API가 per-route output(filePath + assets)을 제공하므로 standalone 불필요.

  return config;
}
