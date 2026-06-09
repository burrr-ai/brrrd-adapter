// A-6: Next.js 의 legacy IncrementalCache 의 CacheHandler 인터페이스 폴리필.
// `unstable_cache`, fetch revalidate, page ISR 등이 사용. 이 모듈을 next.config
// 의 `cacheHandler` (singular) 에 등록.
//
// 인터페이스: next/dist/server/lib/incremental-cache/index.d.ts 의 CacheHandler.
// CacheHandlerValue = { lastModified, age?, cacheState?, value: IncrementalCacheValue | null }
//
// 직렬화 전략: 전체 CacheHandlerValue 를 JSON.stringify → utf-8 bytes 로 저장.
// 단, APP_PAGE 캐시 value 는 `rscData`/`html`(Node Buffer) 과 `segmentData`(Map)
// 같은 non-plain 필드를 담는다. plain JSON 왕복은 Buffer → {type:"Buffer",data:[…]}
// 로 깨뜨려, 정적 RSC 서빙 시 `RenderResult.fromStatic` 의 readable getter 가
// `Buffer.isBuffer` 를 통과 못 해 web stream 대신 plain 객체를 반환 → Next 의
// `pipeToNodeResponse` 가 `.pipeTo` 없다고 500(E180) 낸다. 그래서 Buffer/Uint8Array/
// Map 를 sentinel 로 인코딩해 무손실 왕복한다 (ReadableStream 은 여전히 비대상 —
// modern cacheHandlers(cache-handler.mjs)가 스트림 value 를 따로 처리).

const BUF = globalThis.Buffer;

// JSON.stringify replacer. `this[key]` 로 toJSON 적용 전 원본을 봐야 Buffer 를 잡는다.
function encodeReplacer(key, value) {
  const raw = this[key];
  if (BUF && BUF.isBuffer(raw)) {
    return { __brrrd_t__: "Buffer", d: raw.toString("base64") };
  }
  if (raw instanceof Uint8Array) {
    return { __brrrd_t__: "U8", d: BUF.from(raw).toString("base64") };
  }
  if (raw instanceof Map) {
    return { __brrrd_t__: "Map", e: Array.from(raw.entries()) };
  }
  return value;
}

// JSON.parse reviver (bottom-up: 중첩 Buffer 가 Map 보다 먼저 복원된다).
function decodeReviver(_key, value) {
  if (value && typeof value === "object" && value.__brrrd_t__) {
    switch (value.__brrrd_t__) {
      case "Buffer":
        return BUF.from(value.d, "base64");
      case "U8":
        return new Uint8Array(BUF.from(value.d, "base64"));
      case "Map":
        return new Map(value.e);
    }
  }
  return value;
}

class BrrrdLegacyCacheHandler {
  constructor(_ctx) {
    // ctx 는 무시 — brrrd 의 backend 가 전역 (OpState 에 주입).
  }

  async get(cacheKey, _ctx) {
    const res = await Deno.core.ops.op_brrrd_cache_get(cacheKey);
    if (!res) return null;
    if (res.is_expired) return null;
    try {
      const valueBuf = res.value instanceof Uint8Array
        ? res.value
        : new Uint8Array(res.value);
      const text = new TextDecoder().decode(valueBuf);
      const parsed = JSON.parse(text, decodeReviver);
      return parsed; // { lastModified, age?, cacheState?, value }
    } catch (_e) {
      return null;
    }
  }

  async set(cacheKey, data, ctx) {
    const payload = {
      lastModified: Date.now(),
      value: data,
    };
    const text = JSON.stringify(payload, encodeReplacer);
    const bytes = new TextEncoder().encode(text);
    const tags = (ctx && Array.isArray(ctx.tags)) ? ctx.tags : [];
    const ttl = (ctx && typeof ctx.revalidate === "number") ? ctx.revalidate : 0;
    await Deno.core.ops.op_brrrd_cache_set(cacheKey, bytes, tags, ttl);
  }

  async revalidateTag(tags, _durations) {
    const arr = Array.isArray(tags) ? tags : [tags];
    for (const tag of arr) {
      await Deno.core.ops.op_brrrd_cache_revalidate_tag(tag);
    }
  }

  resetRequestCache() {
    // no-op
  }
}

export default BrrrdLegacyCacheHandler;
export { BrrrdLegacyCacheHandler, decodeReviver, encodeReplacer };
