import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

import { adaptOptionalInstrumentation } from '../dist/runtime-dependency-policy.js';
const require=createRequire(import.meta.url);
const file=require.resolve('next/dist/server/lib/router-utils/instrumentation-globals.external.js');
function fixture(t,source){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brrrd-optional-hook-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.next/server'),{recursive:true});
  if(source!==undefined)fs.writeFileSync(path.join(root,'.next/server/instrumentation.js'),source);
  const exports={};vm.runInNewContext(adaptOptionalInstrumentation(fs.readFileSync(file,'utf8')),{exports,module:{exports},require:createRequire(file),process:{env:{}},performance,console});
  return {root,exports};
}
test('an actually missing instrumentation file is optional without a stub',async t=>{
  const f=fixture(t);assert.equal(await f.exports.getInstrumentationModule(f.root,'.next'),undefined);
  await f.exports.ensureInstrumentationRegistered(f.root,'.next');
});
test('a present hook import dependency failure is not classified as no hook',async t=>{
  const f=fixture(t,"require('./missing-dependency.js');");
  await assert.rejects(f.exports.getInstrumentationModule(f.root,'.next'),error=>error.code==='MODULE_NOT_FOUND');
});
test('a present hook registration error remains a real rejection',async t=>{
  const f=fixture(t,"exports.register=()=>{throw new Error('actual-registration-failed');};");
  await assert.rejects(f.exports.ensureInstrumentationRegistered(f.root,'.next'),/actual-registration-failed/);
});
