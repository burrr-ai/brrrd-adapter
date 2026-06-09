// A-6: Next.js 16 CacheHandler 인터페이스를 구현해 brrrd 의
// op_brrrd_cache_* ops 로 위임. Next config 의 cacheHandlers.default 에
// 이 모듈을 등록하면 ISR / fetch cache / use cache 가 brrrd backend 로 흐른다.
//
// 인터페이스 출처: next/dist/server/lib/cache-handlers/types.d.ts (Next 16.x).
//
// 주의:
// - tag-based getExpiration 는 backend 가 timestamp 모르니까 Infinity 반환 →
//   Next 가 get 의 softTags 로 직접 stale 판정.
// - 본 모듈은 brrrd isolate 안에서만 동작 (Deno.core.ops 의존). 다른 Next
//   런타임에서 import 하면 ReferenceError.

class BrrrdCacheHandler {
  async get(cacheKey, softTags) {
    const res = await Deno.core.ops.op_brrrd_cache_get(cacheKey);
    if (!res) return undefined;
    if (res.is_expired) return undefined;

    const valueBuf = res.value instanceof Uint8Array
      ? res.value
      : new Uint8Array(res.value);
    const value = new ReadableStream({
      start(controller) {
        controller.enqueue(valueBuf);
        controller.close();
      },
    });
    return {
      value,
      tags: res.tags || [],
      stale: 60,
      timestamp: Date.now() - Math.floor((res.age_secs || 0) * 1000),
      expire: 3600,
      revalidate: 60,
    };
  }

  async set(cacheKey, pendingEntry) {
    const entry = await pendingEntry;
    const reader = entry.value.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    await Deno.core.ops.op_brrrd_cache_set(
      cacheKey,
      merged,
      entry.tags || [],
      entry.revalidate || 0,
    );
  }

  async refreshTags() {
    // backend 가 매 get 시 directly stale 판정. local manifest 없음.
  }

  async getExpiration(_tags) {
    // Infinity → Next 가 softTags 를 get 에 넘기게 만들어 stale check 위임.
    return Infinity;
  }

  async updateTags(tags, _durations) {
    for (const tag of tags) {
      await Deno.core.ops.op_brrrd_cache_revalidate_tag(tag);
    }
  }
}

export default BrrrdCacheHandler;
export { BrrrdCacheHandler };
