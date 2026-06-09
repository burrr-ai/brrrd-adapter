// A-6: Implements the Next.js 16 CacheHandler interface and delegates to
// brrrd's op_brrrd_cache_* ops. Registering this module as cacheHandlers.default
// in the Next config routes ISR / fetch cache / use cache through the brrrd backend.
//
// Interface source: next/dist/server/lib/cache-handlers/types.d.ts (Next 16.x).
//
// Note:
// - tag-based getExpiration returns Infinity because the backend doesn't know the
//   timestamp, so Next determines staleness directly via the softTags passed to get.
// - This module only works inside the brrrd isolate (it depends on Deno.core.ops).
//   Importing it from another Next runtime throws a ReferenceError.

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
    // The backend determines staleness directly on every get. There is no local manifest.
  }

  async getExpiration(_tags) {
    // Infinity makes Next pass softTags to get, delegating the staleness check to it.
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
