import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrrrdCacheHandler } from '../runtime/cache-handler.mjs';
import { BrrrdLegacyCacheHandler } from '../runtime/cache-handler-legacy.mjs';
import { tagMutation } from '../runtime/cache-tags.mjs';

// A codec/handler unit provider; this is not a native CacheState acceptance proof.
function provider() {
  const entries = new Map(), tags = new Map(), operations = [];
  const binding = { async fetch(_url, init) {
    const body = init.body, length = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, false);
    const input = JSON.parse(new TextDecoder().decode(body.subarray(4,4+length)));operations.push(input);
    if(input.op === 'set') {
      entries.set(input.key,{value:body.slice(4+length),tags:input.tags});return Response.json(null);
    }
    if(input.op === 'get') {
      const hit=entries.get(input.key);if(!hit)return new Response(null,{status:404});
      const metadata=new TextEncoder().encode(JSON.stringify({tags:hit.tags,age_secs:0,is_expired:false,tag_states:hit.tags.map(tag=>snapshot(tag))}));
      const frame=new Uint8Array(4+metadata.length+hit.value.length);new DataView(frame.buffer).setUint32(0,metadata.length,false);
      frame.set(metadata,4);frame.set(hit.value,4+metadata.length);return new Response(frame);
    }
    if(input.op === 'tag_snapshot')return Response.json(snapshot(input.key));
    if(input.op === 'commit_tag') {
      const previous=snapshot(input.key), next={...previous,revision:String(BigInt(previous.revision)+1n)};
      for(const field of ['stale','expired'])if(input[field]!==null)next[field]=input[field];tags.set(input.key,next);return Response.json(next);
    }
    throw new Error(`unexpected operation ${input.op}`);
  }};
  function snapshot(tag){return tags.get(tag)||{tag,status:'committed',epoch:null,revision:'0',stale:0,expired:0};}
  return {binding,operations,entries,tags};
}
const fresh=()=>{globalThis.__brrrd_next_cache_tags_manifest=new Map();};

test('modern native handler preserves binary stream envelope through real framed codec',async()=>{
  fresh();const p=provider(),handler=new BrrrdCacheHandler(p.binding),bytes=new Uint8Array([0,255,128,10]);
  const entry={value:new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),tags:['tag'],stale:60,timestamp:Date.now(),expire:3600,revalidate:60};
  await handler.set('binary',Promise.resolve(entry));
  assert.deepEqual(new Uint8Array(await new Response(entry.value).arrayBuffer()),bytes);
  const hit=await handler.get('binary',[]);assert.deepEqual(new Uint8Array(await new Response(hit.value).arrayBuffer()),bytes);
  assert.deepEqual(hit.tags,['tag']);assert.ok(p.operations.some(v=>v.op==='tag_snapshot'));
  assert.equal(await handler.get('missing',[]),undefined);
});

test('legacy native handler keeps Next APP_PAGE Buffer and Map serialization',async()=>{
  fresh();const p=provider(),handler=new BrrrdLegacyCacheHandler({cacheBinding:p.binding});
  const data={kind:'APP_PAGE',html:Buffer.from([0,255,128]),rscData:Buffer.from('rsc'),segmentData:new Map([['x',Buffer.from([1,2])]])};
  await handler.set('page',data,{tags:['page'],revalidate:0});const hit=await handler.get('page',{});
  assert.deepEqual(hit.value.html,data.html);assert.deepEqual(hit.value.rscData,data.rscData);assert.deepEqual(hit.value.segmentData,data.segmentData);
  assert.deepEqual(p.operations.map(v=>v.op),['set','get','tag_snapshot']);
});

test('modern and legacy native mutations share authoritative publication and partial intent',async()=>{
  fresh();const p=provider(),modern=new BrrrdCacheHandler(p.binding),legacy=new BrrrdLegacyCacheHandler({cacheBinding:p.binding});
  await modern.updateTags(['tag'],{expire:60});const future=p.tags.get('tag').expired;
  await legacy.revalidateTag('tag',{});assert.equal(p.tags.get('tag').expired,future);
  assert.equal(p.operations.at(-1).expired,null);assert.equal(p.tags.get('tag').revision,'2');
  await legacy.revalidateTag('tag',{expire:0});assert.ok(p.tags.get('tag').expired<future);
  assert.deepEqual(globalThis.__brrrd_next_cache_tags_manifest.get('tag'),{stale:p.tags.get('tag').stale,expired:p.tags.get('tag').expired});
});

test('native capability failure is propagated without build-time memory fallback',async()=>{
  fresh();const broken={async fetch(){return Response.json({error:'backend unavailable'},{status:500});}};
  const modern=new BrrrdCacheHandler(broken),legacy=new BrrrdLegacyCacheHandler({cacheBinding:broken});
  await assert.rejects(modern.get('key',[]),/backend unavailable/);await assert.rejects(legacy.get('key',{}),/backend unavailable/);
  await assert.rejects(modern.set('key',Promise.resolve({value:new ReadableStream({start(c){c.close();}}),tags:[],timestamp:Date.now()})),/backend unavailable/);
  await assert.rejects(legacy.set('key',{kind:'FETCH',data:{}},{tags:[]}),/backend unavailable/);
  await assert.rejects(new BrrrdCacheHandler({}).get('key',[]),/binding is required/);
});

for(const status of [408,429,504]){
  test(`native ${status} degrades reads to a miss and writes to not stored; invalidation keeps its error`,async()=>{
    fresh();const p=provider(),refused=new Set(['get','set','tag_snapshot','commit_tag']);
    const binding={async fetch(url,init){
      const body=init.body,length=new DataView(body.buffer,body.byteOffset,4).getUint32(0,false);
      const input=JSON.parse(new TextDecoder().decode(body.subarray(4,4+length)));
      if(refused.has(input.op))return Response.json({error:`refused ${input.op}`},{status});
      return p.binding.fetch(url,init);
    }};
    const modern=new BrrrdCacheHandler(binding),legacy=new BrrrdLegacyCacheHandler({cacheBinding:binding});
    const {cacheDegradation}=await import('../runtime/cache-handler.mjs');const before={...cacheDegradation};
    const warnings=[],warn=console.warn;console.warn=line=>warnings.push(JSON.parse(line));
    try{
      assert.equal(await modern.get('key',[]),undefined);assert.equal(await legacy.get('key',{}),null);
      const entry={value:new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));c.close();}}),tags:['t'],timestamp:Date.now()};
      await modern.set('key',Promise.resolve(entry));
      assert.deepEqual(new Uint8Array(await new Response(entry.value).arrayBuffer()),new Uint8Array([1]),'caller stream intact');
      await legacy.set('key',{kind:'FETCH',data:{}},{tags:['t']});
      // A stored entry whose tag state read is refused is a miss, never a stale hit.
      refused.delete('get');refused.delete('set');
      await legacy.set('page',{kind:'FETCH',data:{}},{tags:['t']});
      assert.equal(await legacy.get('page',{}),null);
      await assert.rejects(modern.updateTags(['t'],{expire:0}),/refused commit_tag/);
      await assert.rejects(legacy.revalidateTag('t',{}),/refused commit_tag/);
    }finally{console.warn=warn;}
    assert.equal(cacheDegradation.readMisses-before.readMisses,3);assert.equal(cacheDegradation.writesSkipped-before.writesSkipped,2);
    assert.deepEqual(warnings.map(w=>[w.event,w.outcome,w.op,w.status]),[
      ['brrrd.cache.degraded','miss','get',status],['brrrd.cache.degraded','miss','get',status],
      ['brrrd.cache.degraded','not_stored','set',status],['brrrd.cache.degraded','not_stored','set',status],
      ['brrrd.cache.degraded','miss','get',status]]);
  });
}

test('duration intent is read once, retains omitted expiry and passes explicit zero',()=>{
  let reads=0;assert.deepEqual(tagMutation({get expire(){reads++;return 0;}},100),{stale:100,expired:100});assert.equal(reads,1);
  assert.deepEqual(tagMutation({},100),{stale:100,expired:null});assert.deepEqual(tagMutation(undefined,100),{stale:null,expired:100});
});

// The fake provider checks only handler policy; actual page ISR uses CLI/Fleet.
test('native page stale retention and path invalidation use the backend authority', async()=>{
  fresh();const p=provider(),handler=new BrrrdLegacyCacheHandler({cacheBinding:p.binding});
  await handler.set('timed',{kind:'APP_PAGE',html:'page',rscData:Buffer.from('flight'),headers:{'x-next-cache-tags':'_N_T_/isr'}},{revalidate:5});
  assert.equal(p.operations[0].ttl,0);
  assert.equal((await handler.get('timed',{})).value.html,'page');
  await handler.revalidateTag('_N_T_/isr',{expire:0});
  assert.equal(await handler.get('timed',{}),null);
});

test('native disk fallback uses original artifact age and cannot revive after path invalidation',async t=>{
  fresh();const root=fs.mkdtempSync(path.join(os.tmpdir(),'brrrd-native-disk-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'app'));const html=path.join(root,'app/isr.html');fs.writeFileSync(html,'prerender');fs.utimesSync(html,0,0);
  const generated=Date.now()-10000;
  fs.writeFileSync(path.join(root,'app/isr.rsc'),Buffer.from('real flight'));
  fs.writeFileSync(path.join(root,'app/isr.meta'),JSON.stringify({headers:{'x-next-cache-tags':'_N_T_/isr'}}));
  fs.writeFileSync(path.join(root,'brrrd-prerender-cache.json'),JSON.stringify({version:1,buildId:'disk',lastModified:{'app/isr.html':generated}}));
  const p=provider(),handler=new BrrrdLegacyCacheHandler({cacheBinding:p.binding,serverDistDir:root});
  const hit=await handler.get('/isr',{kind:'APP_PAGE'});assert.equal(hit.lastModified,generated);assert.equal(hit.value.rscData.toString(),'real flight');
  const sidecar=path.join(root,'brrrd-prerender-cache.json');
  for (const age of [0,-1,Date.now()+60000]) {
    fs.writeFileSync(sidecar,JSON.stringify({lastModified:{'app/isr.html':age}}));
    assert.equal(await handler.get('/isr',{kind:'APP_PAGE'}),null);
  }
  fs.writeFileSync(sidecar,JSON.stringify({lastModified:{'app/isr.html':generated}}));
  await handler.revalidateTag('_N_T_/isr',{expire:0});assert.equal(await handler.get('/isr',{kind:'APP_PAGE'}),null);
});


test('native get reads backend authority while another request has an unresolved producer', {timeout:1000},async()=>{
  fresh();const p=provider(),writer=new BrrrdCacheHandler(p.binding),reader=new BrrrdCacheHandler(p.binding);
  const entry=text=>({value:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(text));c.close();}}),tags:[],stale:60,timestamp:Date.now(),expire:3600,revalidate:60});
  await writer.set('pending-native',Promise.resolve(entry('old')));
  let release;const producer=new Promise(resolve=>{release=resolve;});
  const pending=writer.set('pending-native',producer);
  const hit=await reader.get('pending-native',[]);
  assert.equal(await new Response(hit.value).text(),'old');
  release(entry('new'));await pending;
  assert.equal(await new Response((await reader.get('pending-native',[])).value).text(),'new');
});
