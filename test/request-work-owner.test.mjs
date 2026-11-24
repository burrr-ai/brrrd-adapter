import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  ownRequestWork,
  createOwnedCacheHandler,
  createOwnedLegacyCacheHandler,
} from '../runtime/cache-handler.mjs';

test('owner registers and returns the exact complete promise synchronously', async () => {
  const gate = Promise.withResolvers();
  const order = [];
  const returned = ownRequestWork(promise => {
    assert.equal(promise, gate.promise);
    order.push('owned');
  }, gate.promise);
  assert.equal(returned, gate.promise);
  assert.deepEqual(order, ['owned']);
  gate.resolve('done');
  assert.equal(await returned, 'done');
  assert.throws(() => ownRequestWork(undefined, Promise.resolve()), /owner/);
  assert.throws(() => ownRequestWork(() => {}, undefined), /promise/);
});

test('modern facade owns serialization, persistence and finally cleanup, including rejection', async () => {
  const persisted = Promise.withResolvers();
  const pending = new Map();
  const submitted = [];
  const owners = [];
  let original;
  const handler = {
    get(...args) { submitted.push(['get', args]); return Promise.resolve('value'); },
    set(key, entry) {
      original = (async () => {
        pending.set(key, true);
        try { await entry; await persisted.promise; }
        finally { pending.delete(key); }
      })();
      return original;
    },
    refreshTags() { return Promise.resolve(); },
    getExpiration() { return Promise.resolve(42); },
    updateTags() { return Promise.resolve(); },
  };
  const facade = createOwnedCacheHandler(handler, promise => owners.push(promise));
  const entry = Promise.withResolvers();
  const work = facade.set('key', entry.promise);
  assert.equal(work, original);
  assert.equal(owners[0], work);
  assert.equal(pending.has('key'), true);
  entry.resolve('serialized');
  await Promise.resolve();
  assert.equal(pending.has('key'), true, 'ownership must extend through persistence');
  const failed = assert.rejects(work, /backend failed/);
  persisted.reject(new Error('backend failed'));
  await failed;
  assert.equal(pending.has('key'), false, 'the owned promise includes finally cleanup');
  assert.equal(await facade.get('key', ['tag']), 'value');
  assert.deepEqual(submitted, [['get', ['key', ['tag']]]]);
  await facade.refreshTags();
  assert.equal(await facade.getExpiration(['tag']), 42);
  await facade.updateTags(['tag'], { expire: 0 });
  assert.equal(owners.length, 5);
  assert.throws(() => createOwnedCacheHandler(handler, null), /owner/);
  assert.throws(() => createOwnedCacheHandler({}, () => {}), /get/);
});

test('legacy owner class preserves constructor, receiver and synchronous reset', async () => {
  const owners = [];
  class Base {
    #value;
    resets = 0;
    constructor(value) { this.#value = value; }
    get(key) { return Promise.resolve([this.#value, key]); }
    set(key, value) { return Promise.resolve([this.#value, key, value]); }
    revalidateTag(tags) { return Promise.resolve(tags); }
    resetRequestCache() { this.resets++; }
  }
  const Owned = createOwnedLegacyCacheHandler(Base, promise => owners.push(promise));
  const instance = new Owned('binding');
  assert.ok(instance instanceof Base);
  assert.deepEqual(await instance.get('key'), ['binding', 'key']);
  assert.deepEqual(await instance.set('key', 'value'), ['binding', 'key', 'value']);
  assert.deepEqual(await instance.revalidateTag(['tag']), ['tag']);
  assert.equal(instance.resetRequestCache(), undefined);
  assert.equal(instance.resets, 1);
  assert.equal(owners.length, 3);
  assert.throws(() => createOwnedLegacyCacheHandler(Base, null), /owner/);
  assert.throws(() => createOwnedLegacyCacheHandler(class {}, () => {}), /get/);
});


test('native execution never stores producer promises in module cache Maps', {timeout:1000},async()=>{
  const sourceUrl=new URL('../runtime/cache-handler.mjs',import.meta.url);
  const tagUrl=new URL('../runtime/cache-tags.mjs',import.meta.url).href;
  let assignments=0;
  class DataMap extends Map {
    set(key,value){assignments++;assert.ok(!(value instanceof Promise),'native module map stored a request promise');return super.set(key,value);}
  }
  globalThis.__nativePublicationProbeMap=DataMap;
  const previousManifest=globalThis.__brrrd_next_cache_tags_manifest;
  globalThis.__brrrd_next_cache_tags_manifest=new Map();
  try {
    const source=fs.readFileSync(sourceUrl,'utf8').replace("'./cache-tags.mjs'",JSON.stringify(tagUrl)).replaceAll('new Map()','new globalThis.__nativePublicationProbeMap()');
    const {BrrrdCacheHandler}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    const handler=new BrrrdCacheHandler({async fetch(_url,init){
      const length=new DataView(init.body.buffer,init.body.byteOffset,4).getUint32(0,false);
      const op=JSON.parse(new TextDecoder().decode(init.body.subarray(4,4+length))).op;
      return op==='get'?new Response(null,{status:404}):Response.json(null);
    }});
    const pending=Promise.withResolvers();const work=handler.set('held',pending.promise);
    assert.equal(await handler.get('held',[]),undefined);
    pending.resolve({value:new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));c.close();}}),tags:[],stale:60,timestamp:Date.now(),expire:3600,revalidate:60});
    await work;assert.equal(assignments,0,'native path must leave build cache maps untouched');
  } finally {delete globalThis.__nativePublicationProbeMap;globalThis.__brrrd_next_cache_tags_manifest=previousManifest;}
});
