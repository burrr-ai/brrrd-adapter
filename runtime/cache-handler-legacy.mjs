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
const NEXT_DATA_SUFFIX = ".json";
const RSC_SEGMENT_SUFFIX = ".segment.rsc";
const RSC_SEGMENTS_DIR_SUFFIX = ".segments";
const RSC_SUFFIX = ".rsc";
const memoryEntries = new Map();
const memoryTagTimestamps = new Map();
const appPageTemplateCache = new Map();

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

function explicitRequestTags(ctx) {
  return (ctx && Array.isArray(ctx.tags)) ? ctx.tags : [];
}

function includesAllTags(storedTags, requestedTags) {
  if (!requestedTags || requestedTags.length === 0) return true;
  const stored = new Set(storedTags || []);
  for (const tag of requestedTags) {
    if (!stored.has(tag)) return false;
  }
  return true;
}

function uniqueTags(tags) {
  return Array.from(new Set((tags || []).filter((tag) => typeof tag === "string" && tag.length > 0)));
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

function cacheValueStoredTags(data) {
  const tags = new Set();
  for (const headers of cacheValueHeaders(data)) {
    addDelimitedTags(tags, getHeader(headers, NEXT_CACHE_TAGS_HEADER));
  }
  return Array.from(tags);
}

function fetchValueTags(data) {
  return data?.kind === "FETCH" && Array.isArray(data.tags) ? data.tags : [];
}

function parsedStoredTags(parsed, backendTags = []) {
  return uniqueTags([
    ...backendTags,
    ...fetchValueTags(parsed?.value),
    ...cacheValueStoredTags(parsed?.value),
  ]);
}

function reconcileFetchTags(parsed, storedTags, ctx) {
  if (!shouldFilterEntryByTags(parsed)) {
    return { changed: false, tags: uniqueTags(storedTags) };
  }

  const requested = explicitRequestTags(ctx);
  const tags = uniqueTags([...storedTags, ...requested]);
  if (includesAllTags(storedTags, requested)) {
    return { changed: false, tags };
  }

  parsed.value.tags = uniqueTags([...fetchValueTags(parsed.value), ...requested]);
  return { changed: true, tags };
}

function tagsForInvalidation(parsed, backendTags, ctx) {
  const tags = new Set();
  for (const tag of backendTags || []) tags.add(tag);
  for (const tag of fetchValueTags(parsed?.value)) tags.add(tag);
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

function diskPath(pathModule, serverDistDir, cacheKey, kind, suffix = "") {
  switch (kind) {
    case "FETCH":
      return pathModule.join(serverDistDir, "..", "cache", "fetch-cache", String(cacheKey));
    case "APP_ROUTE":
      return pathModule.join(serverDistDir, "app", `${cacheKey}${suffix}`);
    case "APP_PAGE":
      return pathModule.join(serverDistDir, "app", `${cacheKey}${suffix}`);
    case "PAGES":
      return pathModule.join(serverDistDir, "pages", `${cacheKey}${suffix}`);
    default:
      return null;
  }
}

async function readText(cacheFs, filePath) {
  const data = await cacheFs.readFile(filePath, "utf8");
  return typeof data === "string" ? data : BUF.from(data).toString("utf8");
}

async function readJson(cacheFs, filePath) {
  return JSON.parse(await readText(cacheFs, filePath));
}

async function readJsonIfExistsAsync(cacheFs, filePath) {
  try {
    return await readJson(cacheFs, filePath);
  } catch {
    return undefined;
  }
}

async function readBufferIfExistsAsync(cacheFs, filePath) {
  try {
    return await cacheFs.readFile(filePath);
  } catch {
    return undefined;
  }
}

async function writeFileEnsuringDir(cacheFs, pathModule, filePath, data) {
  await cacheFs.mkdir(pathModule.dirname(filePath));
  await cacheFs.writeFile(filePath, data);
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

function normalizeAppPageKey(cacheKey) {
  let key = String(cacheKey || "");
  const queryIndex = key.indexOf("?");
  if (queryIndex !== -1) key = key.slice(0, queryIndex);
  try {
    key = decodeURIComponent(key);
  } catch {
    // Keep the original byte-safe key when it is not a valid URI component.
  }
  key = key.replace(/^\/+/, "").replace(/\/+$/, "");
  return key || "index";
}

function appPageSegmentMatch(templateSegment, concreteSegment) {
  if (/^\[\[\.\.\.[^\]]+\]\]$/.test(templateSegment)) return true;
  if (/^\[\.\.\.[^\]]+\]$/.test(templateSegment)) return true;
  if (/^\[[^\]]+\]$/.test(templateSegment)) return true;
  return templateSegment === concreteSegment;
}

function appPageTemplateMatches(templateKey, concreteKey) {
  const templateSegments = templateKey.split("/").filter(Boolean);
  const concreteSegments = concreteKey.split("/").filter(Boolean);
  let concreteIndex = 0;

  for (let templateIndex = 0; templateIndex < templateSegments.length; templateIndex += 1) {
    const templateSegment = templateSegments[templateIndex];
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(templateSegment)) {
      return true;
    }
    if (/^\[\.\.\.[^\]]+\]$/.test(templateSegment)) {
      return concreteIndex < concreteSegments.length;
    }
    const concreteSegment = concreteSegments[concreteIndex];
    if (concreteSegment === undefined || !appPageSegmentMatch(templateSegment, concreteSegment)) {
      return false;
    }
    concreteIndex += 1;
  }

  return concreteIndex === concreteSegments.length;
}

function appPageTemplateSpecificity(templateKey) {
  return templateKey.split("/").reduce((score, segment) => {
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) return score;
    if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return score + 1;
    if (/^\[[^\]]+\]$/.test(segment)) return score + 2;
    return score + 10 + segment.length;
  }, 0);
}

function appPageTemplateKeys(serverDistDir) {
  if (appPageTemplateCache.has(serverDistDir)) {
    return appPageTemplateCache.get(serverDistDir);
  }

  const fs = nodeFs();
  const path = nodePath();
  const appDir = path.join(serverDistDir, "app");
  const templates = [];
  const stack = [appDir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.endsWith(RSC_SEGMENTS_DIR_SUFFIX)) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".html")) continue;

      const rel = path.relative(appDir, fullPath).split(path.sep).join("/");
      const key = rel.slice(0, -".html".length);
      if (key.includes("[") && key.includes("]")) templates.push(key);
    }
  }

  templates.sort((a, b) => appPageTemplateSpecificity(b) - appPageTemplateSpecificity(a));
  appPageTemplateCache.set(serverDistDir, templates);
  return templates;
}

function dynamicAppPageCacheKeyCandidates(serverDistDir, cacheKey) {
  const concreteKey = normalizeAppPageKey(cacheKey);
  return appPageTemplateKeys(serverDistDir).filter((templateKey) => (
    appPageTemplateMatches(templateKey, concreteKey)
  ));
}

function readDiskAppPageEntry(serverDistDir, cacheKey, ctx) {
  if (!serverDistDir || ctx?.kind !== "APP_PAGE") return null;

  const candidates = [
    ...appPageCacheKeyCandidates(cacheKey),
    ...dynamicAppPageCacheKeyCandidates(serverDistDir, cacheKey),
  ];

  for (const candidate of candidates) {
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

async function readBuildDiskEntry(cacheFs, pathModule, serverDistDir, cacheKey, ctx, flushToDisk) {
  if (!cacheFs || !pathModule || !serverDistDir || !ctx?.kind) return null;

  try {
    if (ctx.kind === "FETCH") {
      if (!flushToDisk) return null;
      const filePath = diskPath(pathModule, serverDistDir, cacheKey, "FETCH");
      const text = await readText(cacheFs, filePath);
      const stat = await cacheFs.stat(filePath);
      return {
        lastModified: stat.mtime.getTime(),
        value: JSON.parse(text, decodeReviver),
      };
    }

    if (ctx.kind === "APP_ROUTE") {
      const filePath = diskPath(pathModule, serverDistDir, cacheKey, "APP_ROUTE", ".body");
      const body = await cacheFs.readFile(filePath);
      const stat = await cacheFs.stat(filePath);
      const meta = await readJson(cacheFs, filePath.replace(/\.body$/, NEXT_META_SUFFIX));
      return {
        lastModified: stat.mtime.getTime(),
        value: {
          kind: "APP_ROUTE",
          body,
          headers: meta.headers,
          status: meta.status,
        },
      };
    }

    if (ctx.kind === "APP_PAGE") {
      const htmlPath = diskPath(pathModule, serverDistDir, cacheKey, "APP_PAGE", ".html");
      const html = await readText(cacheFs, htmlPath);
      const stat = await cacheFs.stat(htmlPath);
      const meta = await readJsonIfExistsAsync(cacheFs, htmlPath.replace(/\.html$/, NEXT_META_SUFFIX));
      let segmentData;
      if (Array.isArray(meta?.segmentPaths)) {
        segmentData = new Map();
        const segmentsDir = htmlPath.replace(/\.html$/, RSC_SEGMENTS_DIR_SUFFIX);
        for (const segmentPath of meta.segmentPaths) {
          const data = await readBufferIfExistsAsync(
            cacheFs,
            `${segmentsDir}${segmentPath}${RSC_SEGMENT_SUFFIX}`,
          );
          if (data) segmentData.set(segmentPath, data);
        }
      }

      let rscData;
      if (!ctx.isFallback && (!ctx.isRoutePPREnabled || meta?.postponed == null)) {
        rscData = await readBufferIfExistsAsync(
          cacheFs,
          diskPath(pathModule, serverDistDir, cacheKey, "APP_PAGE", RSC_SUFFIX),
        );
      }

      return {
        lastModified: stat.mtime.getTime(),
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

    if (ctx.kind === "PAGES") {
      const htmlPath = diskPath(pathModule, serverDistDir, cacheKey, "PAGES", ".html");
      const html = await readText(cacheFs, htmlPath);
      const stat = await cacheFs.stat(htmlPath);
      const meta = await readJsonIfExistsAsync(cacheFs, htmlPath.replace(/\.html$/, NEXT_META_SUFFIX));
      let pageData = {};
      if (!ctx.isFallback) {
        pageData = await readJson(
          cacheFs,
          diskPath(pathModule, serverDistDir, cacheKey, "PAGES", NEXT_DATA_SUFFIX),
        );
      }
      return {
        lastModified: stat.mtime.getTime(),
        value: {
          kind: "PAGES",
          html,
          pageData,
          headers: meta?.headers,
          status: meta?.status,
        },
      };
    }
  } catch {
    return null;
  }

  return null;
}

async function writeBuildDiskEntry(cacheFs, pathModule, serverDistDir, cacheKey, data, ctx, flushToDisk) {
  if (!flushToDisk || !cacheFs || !pathModule || !serverDistDir || !data) return;

  if (data.kind === "FETCH") {
    const filePath = diskPath(pathModule, serverDistDir, cacheKey, "FETCH");
    await writeFileEnsuringDir(
      cacheFs,
      pathModule,
      filePath,
      JSON.stringify({
        ...data,
        tags: ctx?.fetchCache ? ctx.tags : [],
      }, encodeReplacer),
    );
    return;
  }

  if (data.kind === "APP_ROUTE") {
    const filePath = diskPath(pathModule, serverDistDir, cacheKey, "APP_ROUTE", ".body");
    await writeFileEnsuringDir(cacheFs, pathModule, filePath, data.body);
    await writeFileEnsuringDir(
      cacheFs,
      pathModule,
      filePath.replace(/\.body$/, NEXT_META_SUFFIX),
      JSON.stringify({
        headers: data.headers,
        status: data.status,
        postponed: undefined,
        segmentPaths: undefined,
        prefetchHints: undefined,
      }),
    );
    return;
  }

  if (data.kind !== "APP_PAGE" && data.kind !== "PAGES") return;

  const isAppPath = data.kind === "APP_PAGE";
  const kind = isAppPath ? "APP_PAGE" : "PAGES";
  const htmlPath = diskPath(pathModule, serverDistDir, cacheKey, kind, ".html");
  await writeFileEnsuringDir(cacheFs, pathModule, htmlPath, data.html);

  if (!ctx?.fetchCache && !ctx?.isFallback && !ctx?.isRoutePPREnabled) {
    await writeFileEnsuringDir(
      cacheFs,
      pathModule,
      diskPath(pathModule, serverDistDir, cacheKey, kind, isAppPath ? RSC_SUFFIX : NEXT_DATA_SUFFIX),
      isAppPath ? data.rscData : JSON.stringify(data.pageData),
    );
  }

  if (isAppPath) {
    let segmentPaths;
    if (data.segmentData) {
      segmentPaths = [];
      const segmentsDir = htmlPath.replace(/\.html$/, RSC_SEGMENTS_DIR_SUFFIX);
      for (const [segmentPath, buffer] of data.segmentData) {
        segmentPaths.push(segmentPath);
        await writeFileEnsuringDir(
          cacheFs,
          pathModule,
          `${segmentsDir}${segmentPath}${RSC_SEGMENT_SUFFIX}`,
          buffer,
        );
      }
    }

    await writeFileEnsuringDir(
      cacheFs,
      pathModule,
      htmlPath.replace(/\.html$/, NEXT_META_SUFFIX),
      JSON.stringify({
        headers: data.headers,
        status: data.status,
        postponed: data.postponed,
        segmentPaths,
        prefetchHints: undefined,
      }),
    );
  }
}

class BrrrdLegacyCacheHandler {
  constructor(ctx = {}) {
    this.fs = ctx.fs;
    this.flushToDisk = !!ctx.flushToDisk;
    this.path = nodePath();
    this.serverDistDir = ctx.serverDistDir;
  }

  async get(cacheKey, ctx) {
    const ops = brrrdOps();
    if (!hasBrrrdCacheOps()) {
      const entry = memoryEntries.get(cacheKey);
      if (entry && !isExpired(entry)) {
        try {
          const parsed = JSON.parse(entry.text, decodeReviver);
          const reconciled = reconcileFetchTags(parsed, entry.tags, ctx);
          if (reconciled.changed) {
            entry.tags = reconciled.tags;
            entry.text = JSON.stringify(parsed, encodeReplacer);
            await writeBuildDiskEntry(
              this.fs,
              this.path,
              this.serverDistDir,
              cacheKey,
              parsed.value,
              { ...ctx, fetchCache: true, tags: reconciled.tags },
              this.flushToDisk,
            );
          }
          return isInvalidatedByMemoryTags(parsed, entry, ctx) ? null : parsed;
        } catch {
          return null;
        }
      }
      if (entry) {
        memoryEntries.delete(cacheKey);
      }
      const diskEntry = await readBuildDiskEntry(
        this.fs,
        this.path,
        this.serverDistDir,
        cacheKey,
        ctx,
        this.flushToDisk,
      );
      if (!diskEntry) return null;
      const reconciled = reconcileFetchTags(diskEntry, parsedStoredTags(diskEntry), ctx);
      if (reconciled.changed) {
        await writeBuildDiskEntry(
          this.fs,
          this.path,
          this.serverDistDir,
          cacheKey,
          diskEntry.value,
          { ...ctx, fetchCache: true, tags: reconciled.tags },
          this.flushToDisk,
        );
      }
      return diskEntry;
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
        const reconciled = reconcileFetchTags(
          parsed,
          parsedStoredTags(parsed, res.tags || []),
          ctx,
        );
        if (reconciled.changed) {
          const nextText = JSON.stringify(parsed, encodeReplacer);
          await ops.op_brrrd_cache_set(
            cacheKey,
            new TextEncoder().encode(nextText),
            reconciled.tags,
            parsed.value?.revalidate || 0,
          );
        }
        const invalidatedAt = await maxRuntimeTagExpiration(
          tagsForInvalidation(parsed, reconciled.tags, ctx),
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
      await writeBuildDiskEntry(
        this.fs,
        this.path,
        this.serverDistDir,
        cacheKey,
        data,
        ctx,
        this.flushToDisk,
      );
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
