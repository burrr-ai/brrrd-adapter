// Implements the Next.js 16 cacheHandlers interface. This module is imported by
// both the Next build process and the brrrd isolate, so the default export must
// be a handler object and must not touch runtime-only Deno ops at module load.

const memoryEntries = new Map();
const memoryTagStates = new Map();
const pendingSets = new Map();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const ENVELOPE_MAGIC = textEncoder.encode("brrrd-next-cache-v1\n");

function brrrdOps() {
  return globalThis.Deno?.core?.ops;
}

function nowMs() {
  const perf = globalThis.performance;
  if (
    perf
    && typeof perf.now === "function"
    && typeof perf.timeOrigin === "number"
  ) {
    return Math.round(perf.timeOrigin + perf.now());
  }
  return Date.now();
}

function hasBrrrdCacheOps() {
  const ops = brrrdOps();
  return !!(
    ops
    && typeof ops.op_brrrd_cache_get === "function"
    && typeof ops.op_brrrd_cache_set === "function"
    && typeof ops.op_brrrd_cache_revalidate_tag === "function"
    && typeof ops.op_brrrd_cache_tag_expiration === "function"
  );
}

function hasBrrrdCacheTagStateOps() {
  const ops = brrrdOps();
  return !!(
    hasBrrrdCacheOps()
    && typeof ops.op_brrrd_cache_update_tag === "function"
    && typeof ops.op_brrrd_cache_tag_state === "function"
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

function bytesStartWith(bytes, prefix) {
  if (bytes.byteLength < prefix.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function encodeStoredEntry(entry, bytes) {
  const metadata = textEncoder.encode(JSON.stringify({
    tags: entry.tags || [],
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
  }));
  const out = new Uint8Array(
    ENVELOPE_MAGIC.byteLength + 4 + metadata.byteLength + bytes.byteLength,
  );
  out.set(ENVELOPE_MAGIC, 0);
  new DataView(out.buffer, out.byteOffset + ENVELOPE_MAGIC.byteLength, 4)
    .setUint32(0, metadata.byteLength, false);
  out.set(metadata, ENVELOPE_MAGIC.byteLength + 4);
  out.set(bytes, ENVELOPE_MAGIC.byteLength + 4 + metadata.byteLength);
  return out;
}

function decodeStoredEntry(bytes, fallbackTags, fallbackTimestamp) {
  const valueBuf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!bytesStartWith(valueBuf, ENVELOPE_MAGIC)) {
    return {
      bytes: valueBuf,
      tags: fallbackTags || [],
      stale: 60,
      timestamp: fallbackTimestamp,
      expire: 3600,
      revalidate: 60,
    };
  }

  const headerOffset = ENVELOPE_MAGIC.byteLength;
  const headerLength = new DataView(
    valueBuf.buffer,
    valueBuf.byteOffset + headerOffset,
    4,
  ).getUint32(0, false);
  const bodyOffset = headerOffset + 4 + headerLength;
  const metadataBytes = valueBuf.subarray(headerOffset + 4, bodyOffset);
  const metadata = JSON.parse(textDecoder.decode(metadataBytes));
  return {
    bytes: valueBuf.subarray(bodyOffset),
    tags: Array.isArray(metadata.tags) ? metadata.tags : fallbackTags || [],
    stale: Number.isFinite(metadata.stale) ? metadata.stale : 60,
    timestamp: Number.isFinite(metadata.timestamp) ? metadata.timestamp : fallbackTimestamp,
    expire: Number.isFinite(metadata.expire) ? metadata.expire : 3600,
    revalidate: Number.isFinite(metadata.revalidate) ? metadata.revalidate : 60,
  };
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

function tagStateFromDurations(durations, now) {
  if (durations) {
    return {
      staleAtMs: now,
      expiredAtMs: durations.expire !== undefined
        ? now + durations.expire * 1000
        : 0,
    };
  }
  return { staleAtMs: 0, expiredAtMs: now };
}

function mergeTagState(current, next) {
  return {
    staleAtMs: Math.max(current?.staleAtMs || current?.stale_at_ms || 0, next.staleAtMs || 0),
    expiredAtMs: Math.max(current?.expiredAtMs || current?.expired_at_ms || 0, next.expiredAtMs || 0),
  };
}

function maxMemoryTagState(tags) {
  const out = { staleAtMs: 0, expiredAtMs: 0 };
  for (const tag of tags || []) {
    const state = memoryTagStates.get(tag);
    out.staleAtMs = Math.max(out.staleAtMs, state?.staleAtMs || 0);
    out.expiredAtMs = Math.max(out.expiredAtMs, state?.expiredAtMs || 0);
  }
  return out;
}

async function maxRuntimeTagState(tags) {
  const ops = brrrdOps();
  const out = { staleAtMs: 0, expiredAtMs: 0 };
  const seen = new Set();
  for (const tag of tags || []) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    if (hasBrrrdCacheTagStateOps()) {
      const state = await ops.op_brrrd_cache_tag_state(tag);
      out.staleAtMs = Math.max(out.staleAtMs, state?.staleAtMs || state?.stale_at_ms || 0);
      out.expiredAtMs = Math.max(out.expiredAtMs, state?.expiredAtMs || state?.expired_at_ms || 0);
    } else {
      out.expiredAtMs = Math.max(out.expiredAtMs, await ops.op_brrrd_cache_tag_expiration(tag));
    }
  }
  return out;
}

function updateNextTagsManifest(tags, durations) {
  const manifest = globalThis.__brrrd_next_cache_tags_manifest;
  if (!manifest || typeof manifest.get !== "function" || typeof manifest.set !== "function") {
    return;
  }
  const now = nowMs();
  for (const tag of tags || []) {
    const existing = manifest.get(tag) || {};
    if (durations) {
      const next = { ...existing, stale: now };
      if (durations.expire !== undefined) {
        next.expired = now + durations.expire * 1000;
      }
      manifest.set(tag, next);
    } else {
      manifest.set(tag, { ...existing, expired: now });
    }
  }
}

function cacheEntryWithTagState(entry, tagState) {
  if (tagState.staleAtMs > entry.timestamp) {
    return {
      ...cacheEntryFromStored(entry),
      revalidate: -1,
    };
  }
  return cacheEntryFromStored(entry);
}

function memoryTagStateForEntry(entry, softTags) {
  return maxMemoryTagState([
    ...(entry.tags || []),
    ...(softTags || []),
  ]);
}

function isMemoryEntryExpired(entry, softTags) {
  const now = nowMs();
  if (entry.expire > 0 && now > entry.timestamp + entry.expire * 1000) return true;
  if (entry.revalidate > 0 && now > entry.timestamp + entry.revalidate * 1000) return true;
  const tagState = memoryTagStateForEntry(entry, softTags);
  return tagState.expiredAtMs <= now && tagState.expiredAtMs > entry.timestamp;
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

function cloneCacheEntryForStorage(entry) {
  const [valueForCaller, valueForStorage] = entry.value.tee();
  entry.value = valueForCaller;
  return valueForStorage;
}

class BrrrdCacheHandler {
  async get(cacheKey, softTags) {
    const pending = pendingSets.get(cacheKey);
    if (pending) await pending;

    const ops = brrrdOps();
    if (!hasBrrrdCacheOps()) {
      const entry = memoryEntries.get(cacheKey);
      if (!entry || isMemoryEntryExpired(entry, softTags)) return undefined;
      return cacheEntryWithTagState(entry, memoryTagStateForEntry(entry, softTags));
    }

    const res = await ops.op_brrrd_cache_get(cacheKey);
    if (!res) return undefined;
    if (res.is_expired) return undefined;

    const timestamp = nowMs() - Math.floor((res.age_secs || 0) * 1000);
    const stored = decodeStoredEntry(res.value, res.tags || [], timestamp);
    const tagState = await maxRuntimeTagState([
      ...(stored.tags || []),
      ...(softTags || []),
    ]);
    const now = nowMs();
    if (tagState.expiredAtMs <= now && tagState.expiredAtMs > stored.timestamp) {
      return undefined;
    }
    return {
      value: streamFromBytes(stored.bytes),
      tags: stored.tags || [],
      stale: stored.stale,
      timestamp: stored.timestamp,
      expire: stored.expire,
      revalidate: tagState.staleAtMs > stored.timestamp
        ? -1
        : stored.revalidate,
    };
  }

  async set(cacheKey, pendingEntry) {
    const setPromise = (async () => {
      const entry = await pendingEntry;
      const bytes = await bytesFromStream(cloneCacheEntryForStorage(entry));
      const stored = {
        bytes,
        tags: entry.tags || [],
        stale: entry.stale,
        timestamp: entry.timestamp ?? nowMs(),
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
        encodeStoredEntry(stored, bytes),
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
      return (await maxRuntimeTagState(tags)).expiredAtMs;
    }
    return maxMemoryTagState(tags).expiredAtMs;
  }

  async updateTags(tags, durations) {
    updateNextTagsManifest(tags, durations);
    const now = nowMs();
    const state = tagStateFromDurations(durations, now);
    for (const tag of tags) {
      memoryTagStates.set(tag, mergeTagState(memoryTagStates.get(tag), state));
      const ops = brrrdOps();
      if (hasBrrrdCacheTagStateOps()) {
        await ops.op_brrrd_cache_update_tag(tag, state.staleAtMs, state.expiredAtMs);
      } else if (hasBrrrdCacheOps() && state.expiredAtMs > 0) {
        await ops.op_brrrd_cache_revalidate_tag(tag);
      }
    }
  }
}

const cacheHandler = new BrrrdCacheHandler();

export default cacheHandler;
export { BrrrdCacheHandler, cacheHandler };
