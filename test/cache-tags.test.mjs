import assert from 'node:assert/strict';
import test from 'node:test';

import { CacheTagPublication } from '../runtime/cache-tags.mjs';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const A = 'a'.repeat(32), B = 'b'.repeat(32);
const value = (epoch, revision, expired, tag = 'tag') => ({tag,status:'committed',epoch,revision:String(revision),stale:100,expired});
const setup = () => { const map = new Map(); return {map, tags:new CacheTagPublication(map)}; };
const patch = (stale, expired) => ({stale, expired});
function backend() {
  const states = new Map(), calls = [];
  let hold;
  return {
    states, calls,
    holdNext(g) { hold = g; },
    async commitTag(tag, change) {
      const previous = states.get(tag) || value(null,0,0,tag);
      const next = {...previous,revision:String(BigInt(previous.revision)+1n)};
      for (const field of ['stale','expired']) if (change[field] !== null) next[field] = change[field];
      states.set(tag,next); calls.push({tag,patch:change,state:next});
      const current = hold; hold = null;
      if (current) { current.entered.resolve(); await current.promise; }
      return next;
    },
    async tagSnapshot(tag) { return states.get(tag) || value(null,0,0,tag); },
  };
}

test('deadline magnitude, same millisecond, partial fields and zero do not order commits', async () => {
  const {map,tags}=setup(), b=backend();
  await tags.update(b,'tag',patch(100,60100));
  await tags.update(b,'tag',patch(100,100));
  await tags.update(b,'tag',patch(100,90100));
  await tags.update(b,'tag',patch(101,null));
  assert.deepEqual(b.calls.map(c=>[c.state.revision,c.state.expired]),[['1',60100],['2',100],['3',90100],['4',90100]]);
  assert.deepEqual(map.get('tag'),{stale:101,expired:90100});
  b.states.set('tag',value(null,9,20));
  await tags.update(b,'tag',patch(30,null));
  assert.equal(map.get('tag').expired,20);
  await tags.update(b,'tag',patch(null,0));
  assert.equal(map.get('tag').expired,0);
});

test('batch sequencing is request-local while other requests commit independently', {timeout:1000}, async () => {
  const {map,tags}=setup(), b=backend(), held={...gate(),entered:gate()};b.holdNext(held);
  const first=tags.update(b,['x','y'],patch(100,60100)); await held.entered.promise;
  const second=tags.update(b,'y',patch(200,200));
  await second; await tags.update(b,'peer',patch(200,200));
  assert.deepEqual(b.calls.map(c=>c.tag),['x','y','peer']);
  tags.hydrate([value(null,0,0,'y')],tags.issueRead());
  assert.equal(map.get('y').expired,200);
  held.resolve(); await Promise.all([first,second]);
  assert.deepEqual(b.calls.filter(c=>c.tag==='y').map(c=>c.state.expired),[200,60100]);
  assert.equal(map.get('y').expired,60100);assert.equal(map.get('x').expired,60100);
});

test('newer revision survives reversed shard response and delayed hydration', {timeout:1000}, async () => {
  const {map,tags}=setup(), peer=setup(), b=backend(), held={...gate(),entered:gate()};b.holdNext(held);
  const first=tags.update(b,'tag',patch(10,60010));await held.entered.promise;
  await peer.tags.update(b,'tag',patch(20,20));const latest=b.states.get('tag');
  tags.hydrate([latest],tags.issueRead());assert.equal(map.get('tag').expired,20);
  held.resolve();await first;assert.equal(map.get('tag').expired,20);
  tags.hydrate([{...latest,revision:'1',expired:60010}],tags.issueRead());assert.equal(map.get('tag').expired,20);
  const restarted=setup();restarted.tags.hydrate([latest],restarted.tags.issueRead());
  assert.deepEqual(restarted.map.get('tag'),{stale:20,expired:20});
});

test('authoritative hydration preserves zero and cannot clobber unowned publication', () => {
  const {map,tags}=setup();
  tags.hydrate([value(A,5,6000)],tags.issueRead());tags.hydrate([value(A,6,0)],tags.issueRead());
  assert.deepEqual(map.get('tag'),{stale:100,expired:0});
  tags.hydrate([{...value(A,7,10),status:'unavailable'}],tags.issueRead());
  assert.equal(map.get('tag').expired,0);
  const outside={stale:200,expired:200};map.set('tag',outside);
  tags.hydrate([value(A,8,3000)],tags.issueRead());assert.equal(map.get('tag'),outside);
});

test('unknown commit publishes no speculative intent and cannot block later mutations', async () => {
  const {map,tags}=setup(), b=backend();
  await assert.rejects(tags.update({async commitTag(){return {status:'unavailable'};}},'tag',patch(100,60100)),/outcome unknown/);
  assert.equal(map.has('tag'),false);assert.throws(()=>tags.read('tag'),/authoritative snapshot/);
  await tags.update(b,'tag',patch(100,100));assert.equal(map.get('tag').expired,100);
  assert.equal(b.states.get('tag').revision,'1');
});

test('unsupported ordered backend cannot silently claim a successful native mutation', async () => {
  const {tags}=setup();let calls=0;
  await assert.rejects(tags.update({async commitTag(){calls++;return {status:'unsupported'};}},'tag',patch(1,null)),/unsupported/);
  assert.equal(calls,1);
});

test('first authoritative hydration replaces preexisting unowned entry', () => {
  const {map,tags}=setup();map.set('tag',{stale:10,expired:6000});
  tags.hydrate([value(A,2,20)],tags.issueRead());assert.deepEqual(map.get('tag'),{stale:100,expired:20});
  tags.hydrate([value(A,2,20)],tags.issueRead());assert.equal(map.get('tag').expired,20);
});

test('duplicate tags commit sequentially within their request', async () => {
  const {tags}=setup(), b=backend();await tags.update(b,['tag','tag'],patch(100,100));
  assert.deepEqual(b.calls.map(c=>c.state.revision),['1','2']);
  await tags.update(b,'tag',patch(101,null));assert.equal(b.states.get('tag').revision,'3');
});

test('oversized duplicate batch rejects before any submission', async () => {
  const {tags}=setup(), b=backend();let promise;
  assert.doesNotThrow(()=>{promise=tags.update(b,Array(65).fill('tag'),patch(100,null));});
  await assert.rejects(promise,/operation batch limit/);assert.equal(b.calls.length,0);
  await tags.update(b,'tag',patch(100,100));assert.equal(b.calls.length,1);
});

test('new backend incarnation accepts hard mutation at revision one', async () => {
  const {map,tags}=setup();tags.hydrate([value(A,10,6000)],tags.issueRead());
  await tags.update({async commitTag(){return value(B,1,100);}},'tag',patch(100,100));
  assert.equal(map.get('tag').expired,100);
});

test('new incarnation fences all already issued responses in both adversarial read orders', () => {
  for(const newFirst of [true,false]){
    const {map,tags}=setup();tags.hydrate([value(A,10,6000)],tags.issueRead());
    const newer=tags.issueRead(), older=tags.issueRead();
    const newResult=()=>tags.hydrate([value(B,1,100)],newer);
    const oldResult=()=>tags.hydrate([value(A,99,9000)],older);
    if(newFirst){newResult();oldResult();}else{oldResult();newResult();}
    assert.equal(map.get('tag').expired,100);
    tags.hydrate([value(B,2,101)],tags.issueRead());assert.equal(map.get('tag').expired,101);
  }
});

async function ambiguous(mode){
  const {map,tags}=setup(), started=gate(),release=gate(), calls=[];
  const cache={async commitTag(){calls.push('commit');started.resolve();await release.promise;return value(B,1,100);},
    async tagSnapshot(){calls.push('snapshot');if(mode==='throws')throw new Error('snapshot unavailable');return mode==='unavailable'?{status:'unavailable'}:value(B,1,100);}};
  const task=tags.update(cache,'tag',patch(100,100));await started.promise;
  const oldRead=tags.issueRead();tags.hydrate([value(A,10,6000)],oldRead);
  assert.equal(map.get('tag').expired,6000);release.resolve();await task;
  assert.deepEqual(calls,['commit','snapshot']);
  const expected=mode==='committed'?100:6000;assert.equal(map.get('tag').expired,expected);
  if(mode!=='committed')assert.throws(()=>tags.read('tag'),/outcome unknown/);
  tags.hydrate([value(A,10,6000)],oldRead);assert.equal(map.get('tag').expired,expected);
  tags.hydrate([value(B,2,200)],tags.issueRead());assert.equal(map.get('tag').expired,200);
}
for(const mode of ['committed','unavailable','throws'])test(`raced first observation makes one fresh snapshot: ${mode}`,{timeout:1000},()=>ambiguous(mode));

test('obsolete high revision cannot overwrite a newer backend incarnation', {timeout:1000},async()=>{
  for(const starting of [undefined,null,A]){
    const {map,tags}=setup();if(starting!==undefined)tags.hydrate([value(starting,10,6000)],tags.issueRead());
    const started=gate(),release=gate();let reads=0;
    const task=tags.update({async commitTag(){started.resolve();await release.promise;return value(starting??A,99,60100);},
      async tagSnapshot(){reads++;return value(B,1,100);}},'tag',patch(100,60100));
    await started.promise;tags.hydrate([value(B,1,100)],tags.issueRead());assert.equal(map.get('tag').expired,100);
    release.resolve();await task;assert.equal(map.get('tag').expired,100);assert.equal(reads,starting===A?0:1);
  }
});

test('uncertainty rejects previously issued certainty; fresh equal revision resolves it', {timeout:1000},async()=>{
  const {map,tags}=setup(),started=gate(),release=gate();
  const task=tags.update({async commitTag(){started.resolve();await release.promise;return value(B,1,100);},
    async tagSnapshot(){return {status:'unavailable'};}},'tag',patch(100,100));
  await started.promise;tags.hydrate([value(A,10,6000)],tags.issueRead());const oldRead=tags.issueRead();
  release.resolve();await task;assert.throws(()=>tags.read('tag'),/outcome unknown/);
  tags.hydrate([value(A,11,9000)],oldRead);assert.equal(map.get('tag').expired,6000);
  tags.hydrate([value(A,11,9000)],tags.issueRead());assert.equal(map.get('tag').expired,9000);
});

test('decimal revisions retain exact order beyond Number precision',()=>{
  const {map,tags}=setup();tags.hydrate([value(A,'9007199254740993',200)],tags.issueRead());
  tags.hydrate([value(A,'9007199254740992',6000)],tags.issueRead());assert.equal(map.get('tag').expired,200);
  tags.hydrate([value(A,'9007199254740994',0)],tags.issueRead());assert.equal(map.get('tag').expired,0);
});

// Inspect live state while an ACK is held: no future, deferred resolver, or
// speculative patch may survive in the generation's publication graph.
test('publication contains committed data only while another request owns a held ACK', {timeout:1000},async()=>{
  const {map,tags}=setup(),b=backend(),held={...gate(),entered:gate()};
  tags.hydrate([value(null,0,0)],tags.issueRead());b.holdNext(held);
  const first=tags.update(b,'tag',patch(100,60100));await held.entered.promise;
  const assertData=value=>{
    assert.notEqual(typeof value,'function');assert.ok(!(value instanceof Promise));
    if(value&&typeof value==='object')for(const child of value instanceof Map?value.values():Object.values(value))assertData(child);
  };
  assertData(tags.tags);assert.equal(map.get('tag').expired,0);
  assert.deepEqual(Object.keys(tags.tags.get('tag')).sort(),['committed','epoch','epochFence','known','revision','uncertaintyFence']);
  await tags.update(b,'tag',patch(200,200));assert.equal(tags.read('tag').expired,200);
  held.resolve();await first;assert.equal(tags.read('tag').expired,200);assertData(tags.tags);
});


test('validated batch snapshots caller tags before the first RPC can yield', {timeout:1000},async()=>{
  const {tags}=setup(),b=backend(),held={...gate(),entered:gate()},input=['first','second'];b.holdNext(held);
  const task=tags.update(b,input,patch(100,100));await held.entered.promise;
  input[1]={invalid:'not a tag'};input.push(...Array(65).fill('first'));
  held.resolve();await task;
  assert.deepEqual(b.calls.map(row=>row.tag),['first','second']);
  assert.equal(b.states.get('first').revision,'1');assert.equal(b.states.get('second').revision,'1');
});
