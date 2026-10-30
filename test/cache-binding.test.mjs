import assert from 'node:assert/strict';
import test from 'node:test';

import { createCacheBinding } from '../runtime/cache-handler.mjs';

function input(init) {
  assert.equal(init.method, 'POST');
  assert.ok(init.body instanceof Uint8Array);
  const length = new DataView(init.body.buffer).getUint32(0, false);
  return { metadata: JSON.parse(new TextDecoder().decode(init.body.subarray(4, 4 + length))),
    payload: init.body.subarray(4 + length) };
}

function reply(metadata, payload) {
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  const body = new Uint8Array(4 + header.length + payload.length);
  new DataView(body.buffer).setUint32(0, header.length, false);
  body.set(header, 4); body.set(payload, 4 + header.length);
  return new Response(body);
}

test('native binding is required; transport has no data fallback', () => {
  assert.throws(() => createCacheBinding(), /binding is required/);
  assert.throws(() => createCacheBinding({}), /binding is required/);
});

test('native cache frames keep binary value separate from JSON metadata', async () => {
  const payload = new Uint8Array([0, 127, 128, 255]);
  const seen = [];
  const cache = createCacheBinding({ async fetch(_url, init) {
    const request = input(init); seen.push(request.metadata);
    if (request.metadata.op === 'set') {
      assert.deepEqual(request.payload, payload);
      return Response.json(null);
    }
    return reply({ tags: ['tag'], age_secs: 1, is_expired: false }, payload);
  } });
  await cache.set('key', payload, ['tag'], 30);
  const hit = await cache.get('key');
  assert.deepEqual(hit.value, payload);
  assert.deepEqual(hit.tags, ['tag']);
  assert.deepEqual(seen, [{op:'set',key:'key',tags:['tag'],ttl:30},{op:'get',key:'key'}]);
});

test('native tag patch preserves zero versus omitted fields and backend errors', async () => {
  const seen = [];
  const cache = createCacheBinding({ async fetch(_url, init) {
    const { metadata } = input(init); seen.push(metadata);
    if (metadata.op === 'get') return new Response(null, { status: 404 });
    if (metadata.key === 'unavailable') return Response.json({error:'commit outcome unknown'}, {status:504});
    return Response.json({status:'committed',revision:'9007199254740993',stale:0,expired:0});
  } });
  assert.equal(await cache.get('absent'), null);
  const result = await cache.commitTag('tag', {stale:0});
  assert.equal(result.revision, '9007199254740993');
  assert.deepEqual(seen[1], {op:'commit_tag',key:'tag',stale:0,expired:null});
  await assert.rejects(cache.commitTag('unavailable', {expired:10}), /commit outcome unknown/);
});

test('native cache transport rejects truncated reply and oversized metadata', async () => {
  let called = 0;
  const cache = createCacheBinding({ async fetch() { called++; return new Response(new Uint8Array([0,0,0,10])); } });
  await assert.rejects(cache.get('key'), /truncated/);
  await assert.rejects(cache.get('x'.repeat(65536)), /64KiB/);
  assert.equal(called, 1);
});


test('native cache codec rejects nonbinary input before submitting a write', async () => {
  let submitted = 0;
  const cache = createCacheBinding({ async fetch() { submitted++; return Response.json(null); } });
  await assert.rejects(cache.set('key', [255, 128]), /Uint8Array/);
  await assert.rejects(cache.set('key', 4096), /Uint8Array/);
  assert.equal(submitted, 0);
});
