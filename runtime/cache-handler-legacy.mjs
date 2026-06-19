// A-6: Polyfill for the CacheHandler interface of Next.js's legacy IncrementalCache.
// Used by `unstable_cache`, fetch revalidate, page ISR, etc. Register this module
// under `cacheHandler` (singular) in next.config.
//
// Interface: the CacheHandler from next/dist/server/lib/incremental-cache/index.d.ts.
// CacheHandlerValue = { lastModified, age?, cacheState?, value: IncrementalCacheValue | null }
//
// Serialization strategy: JSON.stringify the entire CacheHandlerValue and store it
// as utf-8 bytes. However, an APP_PAGE cache value carries non-plain fields such as
// `rscData`/`html` (Node Buffer) and `segmentData` (Map). A plain JSON round-trip
// mangles Buffer into {type:"Buffer",data:[…]}, so when serving static RSC the
// readable getter of `RenderResult.fromStatic` fails `Buffer.isBuffer` and returns a
// plain object instead of a web stream. Next's `pipeToNodeResponse` then throws a
// 500 (E180) complaining there is no `.pipeTo`. To avoid this we encode
// Buffer/Uint8Array/Map as sentinels for a lossless round-trip (ReadableStream is
// still out of scope — the modern cacheHandlers (cache-handler.mjs) handle stream
// values separately).

const BUF = globalThis.Buffer;
const memoryEntries = new Map();

// JSON.stringify replacer. We must inspect the original value via `this[key]` before
// toJSON is applied in order to catch a Buffer.
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

// JSON.parse reviver (bottom-up: a nested Buffer is restored before its enclosing Map).
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

function brrrdOps() {
  return globalThis.Deno?.core?.ops;
}

function hasBrrrdCacheOps() {
  const ops = brrrdOps();
  return !!(
    ops
    && typeof ops.op_brrrd_cache_get === "function"
    && typeof ops.op_brrrd_cache_set === "function"
    && typeof ops.op_brrrd_cache_revalidate_tag === "function"
  );
}

function isExpired(entry) {
  return entry.expiresAt > 0 && Date.now() > entry.expiresAt;
}

class BrrrdLegacyCacheHandler {
  constructor(_ctx) {
    // ctx is ignored — brrrd's backend is global (injected into OpState).
  }

  async get(cacheKey, _ctx) {
    const ops = brrrdOps();
    if (!hasBrrrdCacheOps()) {
      const entry = memoryEntries.get(cacheKey);
      if (!entry || isExpired(entry)) {
        if (entry) memoryEntries.delete(cacheKey);
        return null;
      }
      try {
        return JSON.parse(entry.text, decodeReviver);
      } catch {
        return null;
      }
    }

    const res = await ops.op_brrrd_cache_get(cacheKey);
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
    const ops = brrrdOps();
    if (!hasBrrrdCacheOps()) {
      memoryEntries.set(cacheKey, {
        text,
        tags,
        expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0,
      });
      return;
    }
    await ops.op_brrrd_cache_set(cacheKey, bytes, tags, ttl);
  }

  async revalidateTag(tags, _durations) {
    const arr = Array.isArray(tags) ? tags : [tags];
    const ops = brrrdOps();
    for (const tag of arr) {
      if (!hasBrrrdCacheOps()) {
        for (const [key, entry] of memoryEntries) {
          if (entry.tags.includes(tag)) memoryEntries.delete(key);
        }
        continue;
      }
      await ops.op_brrrd_cache_revalidate_tag(tag);
    }
  }

  resetRequestCache() {
    // no-op
  }
}

export default BrrrdLegacyCacheHandler;
export { BrrrdLegacyCacheHandler, decodeReviver, encodeReplacer };
