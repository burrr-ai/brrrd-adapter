import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { modifyConfig } from '../dist/config.js';
import { createNextBuildModel } from '../dist/model.js';
import { createArtifactPlan, executeArtifactPlan } from '../dist/artifact-planner.js';

const empty = {staticResponseMeta:[],dynamicPrerenderRoutes:[],appPrerenderDataRoutes:[],pprSegmentPrefetchRoutes:[],staticRouteSupplement:[],pprPages:[]};

test('actual Next config import and unpacked cache artifact retain the closed module graph',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brrrd-cache-support-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config=modifyConfig({}, {projectDir:root,phase:'phase-production-build',nextVersion:'16.2.7'});
  assert.equal(config.cacheHandler,path.join(root,'node_modules/.cache/@brrrd/adapter/cache-handler-legacy.mjs'));
  const {formatDynamicImportPath}=await import('next/dist/lib/format-dynamic-import-path.js');
  const distDir=path.join(root,'.next');
  const configured=await import(formatDynamicImportPath(distDir,path.relative(distDir,config.cacheHandler)));
  assert.equal(typeof configured.default,'function');
  const context={projectDir:root,repoRoot:root,distDir,config,nextVersion:'16.2.7',buildId:'closed',
    outputs:{pages:[],appPages:[],appRoutes:[],pagesApi:[],prerenders:[],staticFiles:[]}};
  const plan=createArtifactPlan(createNextBuildModel(context),empty,path.join(root,'out'),{hasAppBundle:false});
  const items=plan.items.filter(v=>v.id.startsWith('cache-support:'));
  assert.equal(items.length,3);
  const names=items.map(v=>path.basename(v.packagePath)).sort();assert.deepEqual(names,['cache-handler-legacy.mjs','cache-handler.mjs','cache-tags.mjs']);
  assert.ok(items.every(v=>path.dirname(v.packagePath)==='runtime/node_modules/.cache/@brrrd/adapter'));
  const unpacked=path.join(root,'unpacked');executeArtifactPlan({items},unpacked);
  const base=path.join(unpacked,'runtime/node_modules/.cache/@brrrd/adapter');
  const modern=await import(pathToFileURL(path.join(base,'cache-handler.mjs')));
  const legacy=await import(pathToFileURL(path.join(base,'cache-handler-legacy.mjs')));
  const policy=await import(pathToFileURL(path.join(base,'cache-tags.mjs')));
  assert.ok(modern.default instanceof modern.BrrrdCacheHandler);
  assert.equal(typeof legacy.default,'function');assert.equal(typeof policy.CacheTagPublication,'function');
  assert.deepEqual(fs.readdirSync(base).sort(),names);
});

test('deployment config uses absolute canonical VFS hooks while Node build input remains unchanged',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brrrd-cache-runtime-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const distDir=path.join(root,'.next');fs.mkdirSync(distDir);
  const original={config:{distDir:'.next',cacheHandler:'../node_modules/.cache/@brrrd/adapter/cache-handler-legacy.mjs',cacheHandlers:{default:'../node_modules/.cache/@brrrd/adapter/cache-handler.mjs'}}};
  const source=path.join(distDir,'required-server-files.json');fs.writeFileSync(source,JSON.stringify(original));
  const model=createNextBuildModel({projectDir:root,repoRoot:root,distDir,config:{},nextVersion:'16.2.7',buildId:'runtime-config',outputs:{pages:[],appPages:[],appRoutes:[],pagesApi:[],prerenders:[],staticFiles:[]}});
  const out=path.join(root,'out');const plan=createArtifactPlan(model,empty,out,{hasAppBundle:false});
  const item=plan.items.find(item=>item.id==='runtime-root:required-server-files.json');assert.equal(item.sourceAbsPath,undefined);assert.equal(typeof item.generatedContent,'string');
  executeArtifactPlan({items:[item]},out);assert.deepEqual(JSON.parse(fs.readFileSync(source)),original);
  const emitted=JSON.parse(fs.readFileSync(path.join(out,item.packagePath)));
  assert.equal(emitted.config.cacheHandler,'/bundle/runtime/node_modules/.cache/@brrrd/adapter/cache-handler-legacy.mjs');
  assert.equal(emitted.config.cacheHandlers.default,'/bundle/runtime/node_modules/.cache/@brrrd/adapter/cache-handler.mjs');
});

test('prerender cache metadata captures actual build ages and immutable build identity',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brrrd-prerender-age-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const distDir=path.join(root,'.next'),app=path.join(distDir,'server/app');fs.mkdirSync(app,{recursive:true});
  const html=path.join(app,'isr.html');fs.writeFileSync(html,'build HTML');fs.utimesSync(html,1234,1234);
  const model=createNextBuildModel({projectDir:root,repoRoot:root,distDir,config:{},nextVersion:'16.2.7',buildId:'age-build',outputs:{pages:[],appPages:[],appRoutes:[],pagesApi:[],prerenders:[],staticFiles:[]}});
  const plan=createArtifactPlan(model,empty,path.join(root,'out'),{hasAppBundle:false});
  const metadata=JSON.parse(plan.items.find(item=>item.id==='prerender-cache-metadata').generatedContent);
  assert.deepEqual(metadata,{version:1,buildId:'age-build',lastModified:{'app/isr.html':1234000},fallbackHtml:{}});
});


test('Next16.4 route-cache seed age and public fallback mapping use actual Adapter API output',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brrrd-route-cache-age-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const distDir=path.join(root,'.next'),server=path.join(distDir,'server');
  const relative='route-cache/APP_PAGE/actual-owner-hash/$/isr.html',file=path.join(server,relative);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'actual seed');fs.utimesSync(file,1234,1234);
  const model=createNextBuildModel({projectDir:root,repoRoot:root,distDir,config:{},nextVersion:'16.4.3',buildId:'cache-owner',outputs:{pages:[],appPages:[],appRoutes:[],pagesApi:[],staticFiles:[],prerenders:[{id:'seed',pathname:'/isr',fallback:{filePath:file},config:{}}]}});
  const plan=createArtifactPlan(model,empty,path.join(root,'out'),{hasAppBundle:false});
  const metadata=JSON.parse(plan.items.find(item=>item.id==='prerender-cache-metadata').generatedContent);
  assert.equal(metadata.lastModified[relative],1234000);assert.equal(metadata.fallbackHtml['/isr'],relative);
  assert.ok(plan.items.some(item=>item.mountPath==='.next/server/'+relative));
});
