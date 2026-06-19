import assert from "node:assert/strict";
import { test } from "node:test";

import cacheHandler, {
  BrrrdCacheHandler,
  cacheHandler as namedCacheHandler,
} from "@brrrd/adapter/cache-handler";

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
