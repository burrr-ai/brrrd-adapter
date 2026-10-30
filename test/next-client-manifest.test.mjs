import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

import { adaptManifestLoader, assertStaticClientManifest, emitClientManifestData, CLIENT_DATA_SUFFIX } from '../dist/compatibility/next-client-manifest.js';

const require=createRequire(import.meta.url);
const loader=require.resolve('next/dist/server/load-manifest.external.js');
const {parse}=require('next/dist/compiled/acorn');
const data='globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/api/echo/route"]={"moduleLoading":{"prefix":"/_next/"},"clientModules":{}};';
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brrrd-client-data-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const ctx={projectDir:root,distDir:path.join(root,'.next'),outDir:path.join(root,'out'),buildId:'fixture'};
  const source=path.join(ctx.distDir,'server/app/api/echo/route_client-reference-manifest.js');fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,data);
  const records=emitClientManifestData(ctx);const target=path.join(ctx.outDir,'runtime/.next/server/app/api/echo/route_client-reference-manifest.js');fs.copyFileSync(source,target);
  const exports={},process={env:{NEXT_DEPLOYMENT_ID:'runtime-first'}};
  vm.runInNewContext(adaptManifestLoader(fs.readFileSync(loader,'utf8'),records),{exports,module:{exports},require:createRequire(loader),process,__dirname:path.join(ctx.outDir,'bundles')});
  return {ctx,source,target,exports,process,records};
}

test('static grammar is validated; runtime/context code is refused rather than frozen',()=>{
  assert.doesNotThrow(()=>assertStaticClientManifest(data,parse));
  for(const expression of ['process.env.NEXT_DEPLOYMENT_ID','Date.now()','(()=>42)()','globalThis.secret']){
    assert.throws(()=>assertStaticClientManifest(data.replace('{"moduleLoading":{"prefix":"/_next/"},"clientModules":{}}',expression),parse),/runtime\/context-dependent/);
  }
});

test('Next original VM result equals emitted data; original cache/freeze/clear and runtime seed remain',t=>{
  const f=fixture(t);const original=require(loader).evalManifest(f.source,false,new Map());
  const sidecar=JSON.parse(fs.readFileSync(f.target+CLIENT_DATA_SUFFIX,'utf8'));
  assert.deepEqual(sidecar.value,JSON.parse(JSON.stringify({__RSC_MANIFEST:original.__RSC_MANIFEST})));
  const first=f.exports.evalManifest(f.target);assert.equal(first.process.env.NEXT_DEPLOYMENT_ID,'runtime-first');
  assert.ok(Object.isFrozen(first));assert.ok(Object.isFrozen(first.__RSC_MANIFEST));
  f.process.env.NEXT_DEPLOYMENT_ID='runtime-second';assert.equal(f.exports.evalManifest(f.target),first);
  f.exports.clearManifestCache(f.target);const next=f.exports.evalManifest(f.target);
  assert.notEqual(next,first);assert.equal(next.process.env.NEXT_DEPLOYMENT_ID,'runtime-second');
  const mutable=f.exports.evalManifest(f.target,false);mutable.__RSC_MANIFEST.extra='mutable';
  assert.equal(mutable.__RSC_MANIFEST.extra,'mutable');assert.equal(f.exports.evalManifest(f.target,false).__RSC_MANIFEST.extra,undefined);
  assert.notEqual(f.exports.evalManifest(f.target,false),f.exports.evalManifest(f.target,false));
});

test('original JSON and missing loader behavior are unchanged; original JS path remains the cache key',t=>{
  const f=fixture(t),cache=new Map();const context=f.exports.evalManifest(f.target,true,cache);assert.equal(cache.get(f.target),context);
  const json=path.join(f.ctx.outDir,'ordinary.json');fs.writeFileSync(json,'{"value":42}');assert.equal(f.exports.loadManifest(json).value,42);
  const absent=path.join(f.ctx.outDir,'absent.js');assert.deepEqual(Object.keys(f.exports.evalManifest(absent,false,cache,true)),[]);assert.ok(cache.has(absent));
  fs.writeFileSync(f.target,'');assert.throws(()=>f.exports.evalManifest(f.target,false),/Manifest file is empty/);
});

test('changed source, missing sidecar and changed upstream loader are honest failures',t=>{
  const f=fixture(t);fs.writeFileSync(f.target,data+' ');assert.throws(()=>f.exports.evalManifest(f.target,false),/source changed/);
  fs.writeFileSync(f.target,data);const original=fs.readFileSync(f.target+CLIENT_DATA_SUFFIX,'utf8');fs.writeFileSync(f.target+CLIENT_DATA_SUFFIX,'{"version":99}');assert.throws(()=>f.exports.evalManifest(f.target,false),/invalid compiled/);fs.writeFileSync(f.target+CLIENT_DATA_SUFFIX,original);fs.unlinkSync(f.target+CLIENT_DATA_SUFFIX);assert.throws(()=>f.exports.evalManifest(f.target,false),/ENOENT/);
  assert.throws(()=>adaptManifestLoader(fs.readFileSync(loader,'utf8')+' ',f.records),/source pin/);
});


test('compiled lookup is confined to immutable artifact root, with normal path resolution',t=>{
  const f=fixture(t);
  const external=path.join(f.ctx.projectDir,'outside/server/app/api/echo/route_client-reference-manifest.js');
  fs.mkdirSync(path.dirname(external),{recursive:true});fs.writeFileSync(external,data);
  // No sidecar exists outside the artifact. Original VM evaluation must remain available here.
  assert.ok(f.exports.evalManifest(external,false).__RSC_MANIFEST);
  fs.mkdirSync(path.join(path.dirname(f.target),'unused'));
  const inside=path.dirname(f.target)+'/unused/../'+path.basename(f.target);
  assert.ok(f.exports.evalManifest(inside,false).__RSC_MANIFEST);
  // Test a lexical ../ escape via an actual file, not a string-suffix false positive.
  const relativeEscape=path.relative(path.dirname(f.target),external);
  const escapedPath=path.dirname(f.target)+'/'+relativeEscape;
  assert.ok(f.exports.evalManifest(escapedPath,false).__RSC_MANIFEST);
});
