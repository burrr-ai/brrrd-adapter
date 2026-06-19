// Implements the Next.js 16 cacheHandlers interface. This module is imported by
// both the Next build process and the brrrd isolate, so the default export must
// be a handler object and must not touch runtime-only Deno ops at module load.

const memoryEntries = new Map();
const memoryTagTimestamps = new Map();
const pendingSets = new Map();

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

function streamFromBytes(bytes) {
  const valueBuf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(valueBuf);
      controller.close();
    },
  });
}

async function bytesFromStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function maxTagTimestamp(tags) {
  let max = 0;
  for (const tag of tags || []) {
    max = Math.max(max, memoryTagTimestamps.get(tag) || 0);
  }
  return max;
}

function isMemoryEntryExpired(entry, softTags) {
  const now = Date.now();
  if (entry.expire > 0 && now > entry.timestamp + entry.expire * 1000) return true;
  if (entry.revalidate > 0 && now > entry.timestamp + entry.revalidate * 1000) return true;
  const invalidatedAt = Math.max(
    maxTagTimestamp(entry.tags),
    maxTagTimestamp(softTags),
  );
  return invalidatedAt > entry.timestamp;
}

function cacheEntryFromStored(stored) {
  return {
    value: streamFromBytes(stored.bytes),
    tags: stored.tags || [],
    stale: stored.stale,
    timestamp: stored.timestamp,
    expire: stored.expire,
    revalidate: stored.revalidate,
  };
}

class BrrrdCacheHandler {
  async get(cacheKey, softTags) {
    const pending = pendingSets.get(cacheKey);
    if (pending) await pending;

    const ops = brrrdOps();
    if (!hasBrrrdCacheOps()) {
      const entry = memoryEntries.get(cacheKey);
      if (!entry || isMemoryEntryExpired(entry, softTags)) return undefined;
      return cacheEntryFromStored(entry);
    }

    const res = await ops.op_brrrd_cache_get(cacheKey);
    if (!res) return undefined;
    if (res.is_expired) return undefined;

    const valueBuf = res.value instanceof Uint8Array
      ? res.value
      : new Uint8Array(res.value);
    return {
      value: streamFromBytes(valueBuf),
      tags: res.tags || [],
      stale: 60,
      timestamp: Date.now() - Math.floor((res.age_secs || 0) * 1000),
      expire: 3600,
      revalidate: 60,
    };
  }

  async set(cacheKey, pendingEntry) {
    const setPromise = (async () => {
      const entry = await pendingEntry;
      const bytes = await bytesFromStream(entry.value);
      const stored = {
        bytes,
        tags: entry.tags || [],
        stale: entry.stale,
        timestamp: entry.timestamp ?? Date.now(),
        expire: entry.expire,
        revalidate: entry.revalidate,
      };

      const ops = brrrdOps();
      if (!hasBrrrdCacheOps()) {
        memoryEntries.set(cacheKey, stored);
        return;
      }

      await ops.op_brrrd_cache_set(
        cacheKey,
        bytes,
        stored.tags,
        stored.revalidate || 0,
      );
    })();
    pendingSets.set(cacheKey, setPromise);
    try {
      await setPromise;
    } finally {
      pendingSets.delete(cacheKey);
    }
  }

  async refreshTags() {
    // The brrrd backend and Node build fallback both check tags on read.
  }

  async getExpiration(tags) {
    if (hasBrrrdCacheOps()) {
      return Infinity;
    }
    return maxTagTimestamp(tags);
  }

  async updateTags(tags, _durations) {
    const now = Date.now();
    for (const tag of tags) {
      memoryTagTimestamps.set(tag, now);
      const ops = brrrdOps();
      if (hasBrrrdCacheOps()) {
        await ops.op_brrrd_cache_revalidate_tag(tag);
      }
    }
  }
}

const cacheHandler = new BrrrdCacheHandler();

export default cacheHandler;
export { BrrrdCacheHandler, cacheHandler };
