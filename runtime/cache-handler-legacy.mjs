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
const NEXT_CACHE_TAGS_HEADER = "x-next-cache-tags";
const NEXT_META_SUFFIX = ".meta";
const RSC_SEGMENT_SUFFIX = ".segment.rsc";
const RSC_SEGMENTS_DIR_SUFFIX = ".segments";
const RSC_SUFFIX = ".rsc";
const memoryEntries = new Map();
const memoryTagTimestamps = new Map();

function nodeBuiltin(name) {
  const getBuiltinModule = globalThis.process?.getBuiltinModule;
  if (typeof getBuiltinModule === "function") {
    const mod = getBuiltinModule(name);
    if (mod) return mod;
  }

  const modules = globalThis.__brrrd_modules;
  if (modules) {
    const bareName = String(name).startsWith("node:")
      ? String(name).slice("node:".length)
      : String(name);
    const mod = modules[name] || modules[`node:${bareName}`] || modules[bareName];
    if (mod) return mod.default !== undefined ? mod.default : mod;
  }

  throw new Error(`Node builtin ${name} is not available in this runtime`);
}

function nodeFs() {
  return nodeBuiltin("node:fs");
}

function nodePath() {
  return nodeBuiltin("node:path");
}

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
  );
}

function isExpired(entry) {
  return entry.expiresAt > 0 && nowMs() > entry.expiresAt;
}

function maxMemoryTagTimestamp(tags) {
  let max = 0;
  for (const tag of tags || []) {
    max = Math.max(max, memoryTagTimestamps.get(tag) || 0);
  }
  return max;
}

function requestTags(ctx) {
  return [
    ...((ctx && Array.isArray(ctx.tags)) ? ctx.tags : []),
    ...((ctx && Array.isArray(ctx.softTags)) ? ctx.softTags : []),
  ];
}

function addDelimitedTags(out, value) {
  if (value === undefined || value === null) return;
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    for (const tag of String(item).split(",")) {
      const trimmed = tag.trim();
      if (trimmed) out.add(trimmed);
    }
  }
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
}

function cacheValueHeaders(data) {
  return [
    data?.headers,
    data?.value?.headers,
  ].filter(Boolean);
}

function cacheValueTags(data, ctx) {
  const tags = new Set((ctx && Array.isArray(ctx.tags)) ? ctx.tags : []);
  for (const headers of cacheValueHeaders(data)) {
    addDelimitedTags(tags, getHeader(headers, NEXT_CACHE_TAGS_HEADER));
  }
  return Array.from(tags);
}

function tagsForInvalidation(parsed, backendTags, ctx) {
  const tags = new Set();
  for (const tag of backendTags || []) tags.add(tag);
  for (const tag of requestTags(ctx)) tags.add(tag);
  for (const tag of cacheValueTags(parsed?.value, ctx)) tags.add(tag);
  return Array.from(tags);
}

function entryLastModified(parsed, fallbackMs = 0) {
  return Number.isFinite(parsed?.lastModified) ? parsed.lastModified : fallbackMs;
}

function isInvalidatedByMemoryTags(parsed, entry, ctx) {
  if (!shouldFilterEntryByTags(parsed)) return false;
  const invalidatedAt = Math.max(
    maxMemoryTagTimestamp(entry.tags),
    maxMemoryTagTimestamp(requestTags(ctx)),
  );
  return invalidatedAt > 0 && entryLastModified(parsed) <= invalidatedAt;
}

function shouldFilterEntryByTags(parsed) {
  return parsed?.value?.kind === "FETCH";
}

async function maxRuntimeTagExpiration(tags) {
  const op = brrrdOps()?.op_brrrd_cache_tag_expiration;
  if (typeof op !== "function") return 0;
  let max = 0;
  const seen = new Set();
  for (const tag of tags || []) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    max = Math.max(max, await op(tag));
  }
  return max;
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

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(nodeFs().readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function readBufferIfExists(filePath) {
  try {
    return nodeFs().readFileSync(filePath);
  } catch {
    return undefined;
  }
}

function appCachePath(serverDistDir, cacheKey, suffix = "") {
  return nodePath().join(serverDistDir, "app", `${cacheKey}${suffix}`);
}

function decodedCacheKeyCandidate(cacheKey) {
  try {
    const decoded = decodeURIComponent(cacheKey);
    return decoded === cacheKey ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function appPageCacheKeyCandidates(cacheKey) {
  const candidates = [String(cacheKey)];
  const decoded = decodedCacheKeyCandidate(String(cacheKey));
  if (decoded) candidates.push(decoded);
  return candidates;
}

function readDiskAppPageEntry(serverDistDir, cacheKey, ctx) {
  if (!serverDistDir || ctx?.kind !== "APP_PAGE") return null;

  for (const candidate of appPageCacheKeyCandidates(cacheKey)) {
    const htmlPath = appCachePath(serverDistDir, candidate, ".html");
    let html;
    let stat;
    try {
      const fs = nodeFs();
      html = fs.readFileSync(htmlPath, "utf8");
      stat = fs.statSync(htmlPath);
    } catch {
      continue;
    }

    const meta = readJsonIfExists(htmlPath.replace(/\.html$/, NEXT_META_SUFFIX));
    let segmentData;
    if (Array.isArray(meta?.segmentPaths)) {
      segmentData = new Map();
      for (const segmentPath of meta.segmentPaths) {
        const data = readBufferIfExists(
          appCachePath(
            serverDistDir,
            `${candidate}${RSC_SEGMENTS_DIR_SUFFIX}${segmentPath}`,
            RSC_SEGMENT_SUFFIX,
          ),
        );
        if (data) segmentData.set(segmentPath, data);
      }
    }

    let rscData;
    if (!ctx?.isFallback && (!ctx?.isRoutePPREnabled || meta?.postponed == null)) {
      rscData = readBufferIfExists(appCachePath(serverDistDir, candidate, RSC_SUFFIX));
    }

    return {
      lastModified: Math.round(stat.mtimeMs),
      value: {
        kind: "APP_PAGE",
        html,
        rscData,
        postponed: meta?.postponed,
        headers: meta?.headers,
        status: meta?.status,
        segmentData,
      },
    };
  }

  return null;
}

class BrrrdLegacyCacheHandler {
  constructor(ctx = {}) {
    this.serverDistDir = ctx.serverDistDir;
  }

  async get(cacheKey, ctx) {
    const ops = brrrdOps();
    if (!hasBrrrdCacheOps()) {
      const entry = memoryEntries.get(cacheKey);
      if (!entry || isExpired(entry)) {
        if (entry) memoryEntries.delete(cacheKey);
        return null;
      }
      try {
        const parsed = JSON.parse(entry.text, decodeReviver);
        return isInvalidatedByMemoryTags(parsed, entry, ctx) ? null : parsed;
      } catch {
        return null;
      }
    }

    const res = await ops.op_brrrd_cache_get(cacheKey);
    if (!res) {
      return readDiskAppPageEntry(this.serverDistDir, cacheKey, ctx);
    }
    if (res.is_expired) return null;
    try {
      const valueBuf = res.value instanceof Uint8Array
        ? res.value
        : new Uint8Array(res.value);
      const text = new TextDecoder().decode(valueBuf);
      const parsed = JSON.parse(text, decodeReviver);
      if (shouldFilterEntryByTags(parsed)) {
        const invalidatedAt = await maxRuntimeTagExpiration(
          tagsForInvalidation(parsed, res.tags || [], ctx),
        );
        if (invalidatedAt > 0 && entryLastModified(parsed) <= invalidatedAt) {
          return null;
        }
      }
      return parsed; // { lastModified, age?, cacheState?, value }
    } catch (_e) {
      return null;
    }
  }

  async set(cacheKey, data, ctx) {
    const payload = {
      lastModified: nowMs(),
      value: data,
    };
    const text = JSON.stringify(payload, encodeReplacer);
    const bytes = new TextEncoder().encode(text);
    const tags = cacheValueTags(data, ctx);
    const ttl = (ctx && typeof ctx.revalidate === "number") ? ctx.revalidate : 0;
    const ops = brrrdOps();
    if (!hasBrrrdCacheOps()) {
      memoryEntries.set(cacheKey, {
        text,
        tags,
        expiresAt: ttl > 0 ? nowMs() + ttl * 1000 : 0,
      });
      return;
    }
    await ops.op_brrrd_cache_set(cacheKey, bytes, tags, ttl);
  }

  async revalidateTag(tags, _durations) {
    const arr = Array.isArray(tags) ? tags : [tags];
    updateNextTagsManifest(arr, _durations);
    const timestamp = nowMs();
    for (const tag of arr) memoryTagTimestamps.set(tag, timestamp);
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
