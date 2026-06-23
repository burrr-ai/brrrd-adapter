import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import * as esbuild from "esbuild";

import cacheHandler, {
  BrrrdCacheHandler,
  cacheHandler as namedCacheHandler,
} from "@brrrd/adapter/cache-handler";
import LegacyCacheHandler from "@brrrd/adapter/cache-handler-legacy";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function bytesFromStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function entry(bytes, tags = []) {
  return {
    value: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    tags,
    stale: 60,
    timestamp: Date.now(),
    expire: 3600,
    revalidate: 3600,
  };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `brrrd-${prefix}-`));
}

function cacheFs() {
  return {
    existsSync: fs.existsSync,
    readFile: fs.promises.readFile,
    readFileSync: fs.readFileSync,
    writeFile: (file, data) => fs.promises.writeFile(file, data),
    mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
    stat: fs.promises.stat,
  };
}

async function freshLegacyCacheHandlerClass() {
  const url = pathToFileURL(path.join(repoRoot, "runtime/cache-handler-legacy.mjs"));
  url.search = `fresh=${Date.now()}-${Math.random()}`;
  return (await import(url.href)).BrrrdLegacyCacheHandler;
}

test("modern cache handler default export is the CacheHandler object", () => {
  assert.equal(cacheHandler, namedCacheHandler);
  assert.ok(cacheHandler instanceof BrrrdCacheHandler);
  for (const method of ["get", "set", "refreshTags", "getExpiration", "updateTags"]) {
    assert.equal(typeof cacheHandler[method], "function");
  }
});

test("modern cache handler works in the Next build Node process without Deno ops", async () => {
  const previousDeno = globalThis.Deno;
  try {
    delete globalThis.Deno;
    const bytes = new TextEncoder().encode("cached payload");
    await cacheHandler.set("node-build-key", Promise.resolve(entry(bytes, ["tag:a"])));

    const hit = await cacheHandler.get("node-build-key", []);
    assert.ok(hit);
    assert.deepEqual(await bytesFromStream(hit.value), bytes);

    await cacheHandler.updateTags(["tag:a"]);
    assert.equal(await cacheHandler.get("node-build-key", []), undefined);
  } finally {
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("modern cache handler delegates tag expiration to brrrd ops", async () => {
  const previousDeno = globalThis.Deno;
  const revalidatedTags = new Map();
  const stored = new Map();
  try {
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get(key) {
            return stored.get(key);
          },
          async op_brrrd_cache_set(key, value, tags) {
            stored.set(key, {
              value,
              tags,
              is_expired: false,
              age_secs: 0,
            });
          },
          async op_brrrd_cache_revalidate_tag(tag) {
            revalidatedTags.set(tag, 12345);
            return 0;
          },
          async op_brrrd_cache_tag_expiration(tag) {
            return revalidatedTags.get(tag) ?? 0;
          },
        },
      },
    };

    const bytes = new TextEncoder().encode("runtime cached payload");
    await cacheHandler.set("runtime-key", Promise.resolve(entry(bytes, ["tag:runtime"])));
    assert.deepEqual(await bytesFromStream((await cacheHandler.get("runtime-key", [])).value), bytes);
    assert.equal(await cacheHandler.getExpiration(["tag:runtime"]), 0);

    await cacheHandler.updateTags(["tag:runtime"]);
    assert.equal(await cacheHandler.getExpiration(["tag:runtime"]), 12345);
  } finally {
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("modern cache handler treats duration tag updates as stale before hard expiration", async () => {
  const previousDeno = globalThis.Deno;
  const tagStates = new Map();
  const stored = new Map();
  try {
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get(key) {
            return stored.get(key);
          },
          async op_brrrd_cache_set(key, value, tags) {
            stored.set(key, {
              value,
              tags,
              is_expired: false,
              age_secs: 0,
            });
          },
          async op_brrrd_cache_update_tag(tag, staleAtMs, expiredAtMs) {
            const existing = tagStates.get(tag) ?? { staleAtMs: 0, expiredAtMs: 0 };
            tagStates.set(tag, {
              staleAtMs: Math.max(existing.staleAtMs, staleAtMs),
              expiredAtMs: Math.max(existing.expiredAtMs, expiredAtMs),
            });
            return 0;
          },
          async op_brrrd_cache_revalidate_tag() {
            throw new Error("duration tag updates should use tag state, not hard expiration");
          },
          async op_brrrd_cache_tag_state(tag) {
            return tagStates.get(tag) ?? { staleAtMs: 0, expiredAtMs: 0 };
          },
          async op_brrrd_cache_tag_expiration(tag) {
            return tagStates.get(tag)?.expiredAtMs ?? 0;
          },
        },
      },
    };

    const bytes = new TextEncoder().encode("duration-stale payload");
    const sourceEntry = {
      ...entry(bytes, ["tag:max"]),
      timestamp: Date.now() - 1000,
      revalidate: 3600,
    };
    await cacheHandler.set("runtime-duration-tag-key", Promise.resolve(sourceEntry));
    assert.ok(await cacheHandler.get("runtime-duration-tag-key", []));

    await cacheHandler.updateTags(["tag:max"], { expire: 60 });
    const staleHit = await cacheHandler.get("runtime-duration-tag-key", []);

    assert.ok(staleHit);
    assert.equal(staleHit.revalidate, -1);
    assert.deepEqual(await bytesFromStream(staleHit.value), bytes);
  } finally {
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("modern cache handler treats duration-free tag updates as immediate hard expiration", async () => {
  const previousDeno = globalThis.Deno;
  const tagStates = new Map();
  const stored = new Map();
  try {
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get(key) {
            return stored.get(key);
          },
          async op_brrrd_cache_set(key, value, tags) {
            stored.set(key, {
              value,
              tags,
              is_expired: false,
              age_secs: 0,
            });
          },
          async op_brrrd_cache_update_tag(tag, staleAtMs, expiredAtMs) {
            const existing = tagStates.get(tag) ?? { staleAtMs: 0, expiredAtMs: 0 };
            tagStates.set(tag, {
              staleAtMs: Math.max(existing.staleAtMs, staleAtMs),
              expiredAtMs: Math.max(existing.expiredAtMs, expiredAtMs),
            });
            return 0;
          },
          async op_brrrd_cache_revalidate_tag() {
            throw new Error("tag-state ops should handle immediate hard expiration");
          },
          async op_brrrd_cache_tag_state(tag) {
            return tagStates.get(tag) ?? { staleAtMs: 0, expiredAtMs: 0 };
          },
          async op_brrrd_cache_tag_expiration(tag) {
            return tagStates.get(tag)?.expiredAtMs ?? 0;
          },
        },
      },
    };

    const bytes = new TextEncoder().encode("duration-free payload");
    const sourceEntry = {
      ...entry(bytes, ["tag:immediate"]),
      timestamp: Date.now() - 1000,
      revalidate: 3600,
    };
    await cacheHandler.set("runtime-immediate-tag-key", Promise.resolve(sourceEntry));
    assert.ok(await cacheHandler.get("runtime-immediate-tag-key", []));

    await cacheHandler.updateTags(["tag:immediate"]);
    assert.equal(await cacheHandler.get("runtime-immediate-tag-key", []), undefined);
  } finally {
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("modern cache handler preserves Next cache entry metadata through brrrd ops", async () => {
  const previousDeno = globalThis.Deno;
  const stored = new Map();
  try {
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get(key) {
            return stored.get(key);
          },
          async op_brrrd_cache_set(key, value, tags, ttl) {
            stored.set(key, {
              value,
              tags,
              ttl,
              is_expired: false,
              age_secs: 999,
            });
          },
          async op_brrrd_cache_revalidate_tag() {
            return 0;
          },
          async op_brrrd_cache_tag_expiration() {
            return 0;
          },
        },
      },
    };

    const bytes = new TextEncoder().encode("metadata-bearing payload");
    const timestamp = Date.now() - 1234;
    const sourceEntry = {
      ...entry(bytes, ["tag:metadata"]),
      stale: 300,
      timestamp,
      expire: 4294967294,
      revalidate: 900,
    };

    await cacheHandler.set("runtime-metadata-key", Promise.resolve(sourceEntry));
    const hit = await cacheHandler.get("runtime-metadata-key", []);

    assert.ok(hit);
    assert.deepEqual(await bytesFromStream(hit.value), bytes);
    assert.deepEqual(hit.tags, ["tag:metadata"]);
    assert.equal(hit.stale, sourceEntry.stale);
    assert.equal(hit.timestamp, sourceEntry.timestamp);
    assert.equal(hit.expire, sourceEntry.expire);
    assert.equal(hit.revalidate, sourceEntry.revalidate);
    assert.equal(stored.get("runtime-metadata-key").ttl, sourceEntry.revalidate);
  } finally {
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("modern cache handler preserves the caller entry stream while storing", async () => {
  const previousDeno = globalThis.Deno;
  try {
    delete globalThis.Deno;

    const handler = new BrrrdCacheHandler();
    const bytes = new TextEncoder().encode("stream can be read after set");
    const sourceEntry = entry(bytes, ["tag:stream"]);

    await handler.set("stream-tee-key", Promise.resolve(sourceEntry));

    assert.deepEqual(await bytesFromStream(sourceEntry.value), bytes);
    const hit = await handler.get("stream-tee-key", []);
    assert.ok(hit);
    assert.deepEqual(await bytesFromStream(hit.value), bytes);
  } finally {
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("modern cache handler does not read Date.now during runtime get/set/tag operations", async () => {
  const previousDeno = globalThis.Deno;
  const previousDateNow = Date.now;
  const stored = new Map();
  try {
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get(key) {
            return stored.get(key);
          },
          async op_brrrd_cache_set(key, value, tags) {
            stored.set(key, {
              value,
              tags,
              is_expired: false,
              age_secs: 1,
            });
          },
          async op_brrrd_cache_revalidate_tag() {
            return 0;
          },
          async op_brrrd_cache_tag_expiration() {
            return 0;
          },
        },
      },
    };
    Date.now = () => {
      throw new Error("Date.now must not be used by cache handlers during prerender");
    };

    const bytes = new TextEncoder().encode("date-free payload");
    await cacheHandler.set("date-free-key", Promise.resolve({
      value: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      tags: ["tag:date-free"],
      timestamp: 123456,
      stale: 300,
      expire: 4294967294,
      revalidate: 900,
    }));
    const hit = await cacheHandler.get("date-free-key", []);
    assert.ok(hit);
    assert.deepEqual(await bytesFromStream(hit.value), bytes);
    await cacheHandler.updateTags(["tag:date-free"]);
  } finally {
    Date.now = previousDateNow;
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("cache handlers mirror tag invalidations into Next tags manifest", async () => {
  const previousManifest = globalThis.__brrrd_next_cache_tags_manifest;
  const manifest = new Map();
  try {
    globalThis.__brrrd_next_cache_tags_manifest = manifest;

    await cacheHandler.updateTags(["tag:modern"]);
    assert.ok(manifest.get("tag:modern").expired > 0);

    await cacheHandler.updateTags(["tag:profile"], { expire: 7 });
    assert.ok(manifest.get("tag:profile").stale > 0);
    assert.ok(manifest.get("tag:profile").expired >= manifest.get("tag:profile").stale);

    const legacy = new LegacyCacheHandler();
    await legacy.revalidateTag(["tag:legacy"]);
    assert.ok(manifest.get("tag:legacy").expired > 0);
  } finally {
    if (previousManifest === undefined) {
      delete globalThis.__brrrd_next_cache_tags_manifest;
    } else {
      globalThis.__brrrd_next_cache_tags_manifest = previousManifest;
    }
  }
});

test("legacy cache handler does not read Date.now during get/set/revalidate", async () => {
  const previousDeno = globalThis.Deno;
  const previousDateNow = Date.now;
  const stored = new Map();
  try {
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get(key) {
            return stored.get(key);
          },
          async op_brrrd_cache_set(key, value, tags, ttl) {
            stored.set(key, {
              value,
              tags,
              ttl,
              is_expired: false,
              age_secs: 1,
            });
          },
          async op_brrrd_cache_revalidate_tag() {
            return 0;
          },
        },
      },
    };
    Date.now = () => {
      throw new Error("Date.now must not be used by cache handlers during prerender");
    };

    const legacy = new LegacyCacheHandler();
    await legacy.set(
      "legacy-date-free-key",
      { kind: "APP_ROUTE", body: "payload" },
      { tags: ["tag:legacy-date-free"], revalidate: 900 },
    );
    assert.ok(await legacy.get("legacy-date-free-key"));
    await legacy.revalidateTag(["tag:legacy-date-free"]);
  } finally {
    Date.now = previousDateNow;
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("legacy cache handler persists build-time fetch cache entries to disk", async () => {
  const tmp = tempDir("legacy-build-fetch-");
  const serverDistDir = path.join(tmp, ".next", "server");
  const FirstHandler = await freshLegacyCacheHandlerClass();
  const first = new FirstHandler({
    fs: cacheFs(),
    flushToDisk: true,
    serverDistDir,
  });

  await first.set(
    "fetch-key",
    {
      kind: "FETCH",
      data: {
        headers: {},
        body: "cached fetch payload",
        status: 200,
        url: "https://example.test/data",
      },
      revalidate: 900,
    },
    {
      fetchCache: true,
      tags: ["tag:fetch"],
      revalidate: 900,
    },
  );

  const SecondHandler = await freshLegacyCacheHandlerClass();
  const second = new SecondHandler({
    fs: cacheFs(),
    flushToDisk: true,
    serverDistDir,
  });
  const hit = await second.get("fetch-key", {
    kind: "FETCH",
    tags: ["tag:fetch"],
    softTags: [],
  });

  assert.ok(hit);
  assert.equal(hit.value.kind, "FETCH");
  assert.equal(hit.value.data.body, "cached fetch payload");
  assert.deepEqual(hit.value.tags, ["tag:fetch"]);
});

test("legacy cache handler persists build-time app page entries to disk", async () => {
  const tmp = tempDir("legacy-build-app-page-");
  const serverDistDir = path.join(tmp, ".next", "server");
  const FirstHandler = await freshLegacyCacheHandlerClass();
  const first = new FirstHandler({
    fs: cacheFs(),
    flushToDisk: true,
    serverDistDir,
  });

  await first.set(
    "/",
    {
      kind: "APP_PAGE",
      html: "<html><body>shell</body></html>",
      rscData: Buffer.from("full-rsc"),
      postponed: "postponed-state",
      headers: { "x-next-cache-tags": "tag:page" },
      status: 200,
      segmentData: new Map([
        ["/__PAGE__", Buffer.from("segment-rsc")],
      ]),
    },
    {
      isRoutePPREnabled: true,
      isFallback: false,
    },
  );

  const SecondHandler = await freshLegacyCacheHandlerClass();
  const second = new SecondHandler({
    fs: cacheFs(),
    flushToDisk: true,
    serverDistDir,
  });
  const hit = await second.get("/", {
    kind: "APP_PAGE",
    isRoutePPREnabled: true,
    isFallback: false,
  });

  assert.ok(hit);
  assert.equal(hit.value.kind, "APP_PAGE");
  assert.equal(hit.value.html, "<html><body>shell</body></html>");
  assert.equal(hit.value.postponed, "postponed-state");
  assert.equal(hit.value.segmentData.get("/__PAGE__").toString(), "segment-rsc");
});

test("legacy cache handler stores response cache tags from Next headers", async () => {
  const previousDeno = globalThis.Deno;
  const capturedSets = [];
  try {
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get() {
            return null;
          },
          async op_brrrd_cache_set(key, value, tags, ttl) {
            capturedSets.push({ key, value, tags, ttl });
          },
          async op_brrrd_cache_revalidate_tag() {
            return 0;
          },
        },
      },
    };

    const legacy = new LegacyCacheHandler();
    await legacy.set(
      "route-response-key",
      {
        kind: "APP_ROUTE",
        headers: {
          "content-type": "application/json",
          "x-next-cache-tags": "_N_T_/layout, _N_T_/node",
        },
        body: "payload",
      },
      { tags: ["ctx-tag"], revalidate: 900 },
    );

    assert.equal(capturedSets.length, 1);
    assert.equal(capturedSets[0].key, "route-response-key");
    assert.equal(capturedSets[0].ttl, 900);
    assert.deepEqual(capturedSets[0].tags, [
      "ctx-tag",
      "_N_T_/layout",
      "_N_T_/node",
    ]);
  } finally {
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("legacy cache handler reads response cache tags from wrapped cache values", async () => {
  const previousDeno = globalThis.Deno;
  const capturedSets = [];
  try {
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get() {
            return null;
          },
          async op_brrrd_cache_set(_key, _value, tags) {
            capturedSets.push(tags);
          },
          async op_brrrd_cache_revalidate_tag() {
            return 0;
          },
        },
      },
    };

    const legacy = new LegacyCacheHandler();
    await legacy.set(
      "wrapped-route-response-key",
      {
        value: {
          headers: {
            "X-Next-Cache-Tags": ["_N_T_/posts", "_N_T_/posts/page"],
          },
        },
      },
      {},
    );

    assert.deepEqual(capturedSets[0], ["_N_T_/posts", "_N_T_/posts/page"]);
  } finally {
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("legacy cache handler discards runtime entries invalidated by stored or soft tags", async () => {
  const previousDeno = globalThis.Deno;
  const stored = new Map();
  const revalidatedTags = new Map();
  try {
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get(key) {
            return stored.get(key);
          },
          async op_brrrd_cache_set(key, value, tags, ttl) {
            stored.set(key, {
              value,
              tags,
              ttl,
              is_expired: false,
              age_secs: 0,
            });
          },
          async op_brrrd_cache_revalidate_tag(tag) {
            revalidatedTags.set(tag, Number.MAX_SAFE_INTEGER);
            return 0;
          },
          async op_brrrd_cache_tag_expiration(tag) {
            return revalidatedTags.get(tag) ?? 0;
          },
        },
      },
    };

    const legacy = new LegacyCacheHandler();
    await legacy.set(
      "legacy-explicit-tag-key",
      { kind: "FETCH", data: "explicit payload", revalidate: false },
      { tags: ["tag:explicit"], revalidate: 900 },
    );
    assert.ok(await legacy.get("legacy-explicit-tag-key", { tags: ["tag:explicit"] }));
    await legacy.revalidateTag(["tag:explicit"]);
    assert.equal(
      await legacy.get("legacy-explicit-tag-key", { tags: ["tag:explicit"] }),
      null,
    );

    await legacy.set(
      "legacy-soft-tag-key",
      { kind: "FETCH", data: "soft payload", revalidate: false },
      { tags: [], revalidate: 900 },
    );
    assert.ok(await legacy.get("legacy-soft-tag-key", { softTags: ["tag:soft"] }));
    await legacy.revalidateTag(["tag:soft"]);
    assert.equal(
      await legacy.get("legacy-soft-tag-key", { softTags: ["tag:soft"] }),
      null,
    );
  } finally {
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("legacy cache handler adds newly requested tags to FETCH entries", async () => {
  const previousDeno = globalThis.Deno;
  const stored = new Map();
  try {
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get(key) {
            return stored.get(key);
          },
          async op_brrrd_cache_set(key, value, tags, ttl) {
            stored.set(key, {
              value,
              tags,
              ttl,
              is_expired: false,
              age_secs: 0,
            });
          },
          async op_brrrd_cache_revalidate_tag() {
            return 0;
          },
          async op_brrrd_cache_tag_expiration() {
            return 0;
          },
        },
      },
    };

    const legacy = new LegacyCacheHandler();
    await legacy.set(
      "legacy-new-tags-key",
      { kind: "FETCH", data: "payload", revalidate: false },
      { tags: ["tag:a"], revalidate: 900 },
    );

    assert.ok(await legacy.get("legacy-new-tags-key", { tags: ["tag:a"] }));
    assert.ok(await legacy.get("legacy-new-tags-key", { tags: ["tag:a", "tag:b"] }));
    assert.deepEqual(stored.get("legacy-new-tags-key").tags, ["tag:a", "tag:b"]);
  } finally {
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("legacy cache handler reads build-time PPR APP_PAGE entries from serverDistDir", async () => {
  const previousDeno = globalThis.Deno;
  const root = tempDir("legacy-app-page");
  try {
    const serverDistDir = path.join(root, ".next", "server");
    const appDir = path.join(serverDistDir, "app");
    fs.mkdirSync(path.join(appDir, "🎉.segments", "_tree"), { recursive: true });
    fs.mkdirSync(path.join(appDir, "🎉.segments", "$d$slug"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "🎉.html"), "<main>shell</main>", "utf8");
    fs.writeFileSync(
      path.join(appDir, "🎉.meta"),
      JSON.stringify({
        status: 200,
        headers: {
          "x-next-cache-tags": "_N_T_/%F0%9F%8E%89,tag:page",
        },
        postponed: "postponed-state",
        segmentPaths: ["/_tree", "/$d$slug/__PAGE__"],
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(appDir, "🎉.segments", "_tree.segment.rsc"),
      "tree",
    );
    fs.writeFileSync(
      path.join(appDir, "🎉.segments", "$d$slug", "__PAGE__.segment.rsc"),
      "page",
    );

    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get() {
            return null;
          },
          async op_brrrd_cache_set() {},
          async op_brrrd_cache_revalidate_tag() {
            return 0;
          },
          async op_brrrd_cache_tag_expiration() {
            return Number.MAX_SAFE_INTEGER;
          },
        },
      },
    };

    const legacy = new LegacyCacheHandler({ serverDistDir });
    const hit = await legacy.get("/%F0%9F%8E%89", {
      kind: "APP_PAGE",
      isRoutePPREnabled: true,
      isFallback: false,
    });

    assert.ok(hit);
    assert.equal(hit.value.kind, "APP_PAGE");
    assert.equal(hit.value.html, "<main>shell</main>");
    assert.equal(hit.value.rscData, undefined);
    assert.equal(hit.value.postponed, "postponed-state");
    assert.equal(hit.value.status, 200);
    assert.equal(hit.value.headers["x-next-cache-tags"], "_N_T_/%F0%9F%8E%89,tag:page");
    assert.deepEqual(Array.from(hit.value.segmentData.keys()), ["/_tree", "/$d$slug/__PAGE__"]);
    assert.equal(hit.value.segmentData.get("/_tree").toString(), "tree");
    assert.equal(hit.value.segmentData.get("/$d$slug/__PAGE__").toString(), "page");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("legacy cache handler resolves dynamic build-time PPR APP_PAGE templates for concrete params", async () => {
  const previousDeno = globalThis.Deno;
  const root = tempDir("legacy-dynamic-app-page");
  try {
    const serverDistDir = path.join(root, ".next", "server");
    const appDir = path.join(serverDistDir, "app");
    fs.mkdirSync(path.join(appDir, "[teamSlug]", "[project].segments", "$d$teamSlug", "$d$project"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(appDir, "[teamSlug]", "[project].html"),
      "<main>team project shell</main>",
      "utf8",
    );
    fs.writeFileSync(
      path.join(appDir, "[teamSlug]", "[project].meta"),
      JSON.stringify({
        status: 200,
        headers: {
          "x-next-cache-tags": "_N_T_/[teamSlug]/[project],tag:page",
        },
        postponed: "postponed-state",
        segmentPaths: ["/$d$teamSlug/$d$project/__PAGE__"],
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(
        appDir,
        "[teamSlug]",
        "[project].segments",
        "$d$teamSlug",
        "$d$project",
        "__PAGE__.segment.rsc",
      ),
      "dynamic-page-segment",
    );

    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get() {
            return null;
          },
          async op_brrrd_cache_set() {},
          async op_brrrd_cache_revalidate_tag() {
            return 0;
          },
          async op_brrrd_cache_tag_expiration() {
            return 0;
          },
        },
      },
    };

    const legacy = new LegacyCacheHandler({ serverDistDir });
    const hit = await legacy.get("/acme/dashboard", {
      kind: "APP_PAGE",
      isRoutePPREnabled: true,
      isFallback: false,
    });

    assert.ok(hit);
    assert.equal(hit.value.kind, "APP_PAGE");
    assert.equal(hit.value.html, "<main>team project shell</main>");
    assert.equal(hit.value.postponed, "postponed-state");
    assert.equal(hit.value.status, 200);
    assert.equal(
      hit.value.segmentData.get("/$d$teamSlug/$d$project/__PAGE__").toString(),
      "dynamic-page-segment",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("legacy cache handler resolves fs/path from brrrd registry when process builtin lookup is absent", async () => {
  const previousDeno = globalThis.Deno;
  const previousModules = globalThis.__brrrd_modules;
  const previousGetBuiltinModule = globalThis.process?.getBuiltinModule;
  const root = tempDir("legacy-app-page-registry-builtins");
  try {
    const serverDistDir = path.join(root, ".next", "server");
    const appDir = path.join(serverDistDir, "app");
    fs.mkdirSync(path.join(appDir, "dashboard.segments", "_tree"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "dashboard.html"), "<main>dashboard</main>", "utf8");
    fs.writeFileSync(
      path.join(appDir, "dashboard.meta"),
      JSON.stringify({
        status: 200,
        headers: { "x-next-cache-tags": "_N_T_/dashboard" },
        postponed: "postponed-state",
        segmentPaths: ["/_tree"],
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(appDir, "dashboard.segments", "_tree.segment.rsc"),
      "tree",
    );

    globalThis.__brrrd_modules = {
      "node:fs": fs,
      "fs": fs,
      "node:path": path,
      "path": path,
    };
    if (globalThis.process) {
      globalThis.process.getBuiltinModule = undefined;
    }
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get() {
            return null;
          },
          async op_brrrd_cache_set() {},
          async op_brrrd_cache_revalidate_tag() {
            return 0;
          },
          async op_brrrd_cache_tag_expiration() {
            return Number.MAX_SAFE_INTEGER;
          },
        },
      },
    };

    const legacy = new LegacyCacheHandler({ serverDistDir });
    const hit = await legacy.get("/dashboard", {
      kind: "APP_PAGE",
      isRoutePPREnabled: true,
      isFallback: false,
    });

    assert.ok(hit);
    assert.equal(hit.value.kind, "APP_PAGE");
    assert.equal(hit.value.html, "<main>dashboard</main>");
    assert.deepEqual(Array.from(hit.value.segmentData.keys()), ["/_tree"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
    if (previousModules === undefined) {
      delete globalThis.__brrrd_modules;
    } else {
      globalThis.__brrrd_modules = previousModules;
    }
    if (globalThis.process && previousGetBuiltinModule !== undefined) {
      globalThis.process.getBuiltinModule = previousGetBuiltinModule;
    }
  }
});

test("legacy cache handler is safe for edge webpack scans", async () => {
  const source = path.join(repoRoot, "runtime", "cache-handler-legacy.mjs");

  await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
});

test("legacy cache handler leaves APP_PAGE tag staleness to IncrementalCache", async () => {
  const previousDeno = globalThis.Deno;
  const stored = new Map();
  const revalidatedTags = new Map();
  try {
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get(key) {
            return stored.get(key);
          },
          async op_brrrd_cache_set(key, value, tags, ttl) {
            stored.set(key, {
              value,
              tags,
              ttl,
              is_expired: false,
              age_secs: 0,
            });
          },
          async op_brrrd_cache_revalidate_tag(tag) {
            revalidatedTags.set(tag, Number.MAX_SAFE_INTEGER);
            return 0;
          },
          async op_brrrd_cache_tag_expiration(tag) {
            return revalidatedTags.get(tag) ?? 0;
          },
        },
      },
    };

    const legacy = new LegacyCacheHandler();
    await legacy.set(
      "legacy-app-page-key",
      {
        kind: "APP_PAGE",
        html: "<main>cached</main>",
        headers: {
          "x-next-cache-tags": "tag:page",
        },
        status: 200,
      },
      { tags: ["tag:page"], revalidate: 900 },
    );
    await legacy.revalidateTag(["tag:page"]);

    const hit = await legacy.get("legacy-app-page-key", { kind: "APP_PAGE" });
    assert.ok(hit);
    assert.equal(hit.value.kind, "APP_PAGE");
    assert.equal(hit.value.html, "<main>cached</main>");
  } finally {
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});

test("modern cache handler discards runtime entries invalidated by entry or soft tags", async () => {
  const previousDeno = globalThis.Deno;
  const revalidatedTags = new Map();
  const stored = new Map();
  try {
    globalThis.Deno = {
      core: {
        ops: {
          async op_brrrd_cache_get(key) {
            return stored.get(key);
          },
          async op_brrrd_cache_set(key, value, tags) {
            stored.set(key, {
              value,
              tags,
              is_expired: false,
              age_secs: 10,
            });
          },
          async op_brrrd_cache_revalidate_tag(tag) {
            revalidatedTags.set(tag, Date.now());
            return 0;
          },
          async op_brrrd_cache_tag_expiration(tag) {
            return revalidatedTags.get(tag) ?? 0;
          },
        },
      },
    };

    const bytes = new TextEncoder().encode("stale runtime payload");
    await cacheHandler.set("runtime-explicit-tag-key", Promise.resolve({
      ...entry(bytes, ["tag:explicit"]),
      timestamp: Date.now() - 1000,
    }));
    assert.ok(await cacheHandler.get("runtime-explicit-tag-key", []));
    await cacheHandler.updateTags(["tag:explicit"]);
    assert.equal(await cacheHandler.get("runtime-explicit-tag-key", []), undefined);

    await cacheHandler.set("runtime-soft-tag-key", Promise.resolve({
      ...entry(bytes, []),
      timestamp: Date.now() - 1000,
    }));
    assert.ok(await cacheHandler.get("runtime-soft-tag-key", ["tag:soft"]));
    await cacheHandler.updateTags(["tag:soft"]);
    assert.equal(await cacheHandler.get("runtime-soft-tag-key", ["tag:soft"]), undefined);
  } finally {
    if (previousDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = previousDeno;
    }
  }
});
