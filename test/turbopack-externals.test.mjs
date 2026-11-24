import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { bundleAppHandler } from '../dist/bundler.js';
import { loadNativeBundle } from './fixtures/native-request-owner.mjs';

process.env.BRRRD_RUNTIME_ABI = 'workerd-node-v1';

async function fixture(t, factory, handler, packages = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brrrd-turbopack-externals-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const distDir = path.join(root, '.next');
  const chunks = path.join(distDir, 'server/chunks/ssr');
  fs.mkdirSync(chunks, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'package.json'), '{"type":"commonjs"}');
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/turbopack-node-runtime.js', import.meta.url)), path.join(chunks, '[turbopack]_runtime.js'));
  for (const key of ['@next/cache-handlers', '@next/cache-handlers-map', '@next/cache-handlers-set']) delete globalThis[Symbol.for(key)];
  for (const [name, files] of Object.entries(packages)) {
    const directory = path.join(root, 'node_modules', name);
    fs.mkdirSync(directory, { recursive: true });
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), source);
  }
  fs.writeFileSync(path.join(chunks, 'probe.js'), `module.exports = ["probe", c => { ${factory} }];`);
  const entry = path.join(distDir, 'server/entry.cjs');
  fs.writeFileSync(entry, `
const R = require('./chunks/ssr/[turbopack]_runtime.js')('server/entry.cjs');
R.c('server/chunks/ssr/probe.js');
exports.handler = async (_req, res) => { ${handler} };
`);
  const output = await bundleAppHandler([{ id: 'probe', filePath: entry }], { projectDir: root, distDir, outDir: path.join(root, 'out'), buildId: 'test' });
  const app = await loadNativeBundle(pathToFileURL(output));
  const response = { statusCode: 200, end(body) { this.body = body; } };
  await app.default('probe', { headers: { host: 'test' } }, response);
  return JSON.parse(response.body);
}

test('resolve-only externals declare metadata without evaluating the package', async t => {
  const result = await fixture(t,
    'c.v(() => ({file:c.x.resolve("fixture-resolve-only"), native:c.x.resolve("node:path")}));',
    'res.end(JSON.stringify(R.m("probe").exports()));',
    { 'fixture-resolve-only': { 'package.json': '{"main":"index.cjs"}', 'index.cjs': 'throw Error("resolve-only package was evaluated");' } });
  assert.equal(path.isAbsolute(result.file), true);
  assert.ok(result.file.endsWith('/node_modules/fixture-resolve-only/index.cjs'));
  assert.equal(result.native, 'node:path');
});

for (const id of ['@opentelemetry/sdk-trace-base', 'cloudflare:workers']) {
  test(`unused runtime external require keeps the dependency policy: ${id}`, async t => {
    const result = await fixture(t,
      `const unused = () => c.x(${JSON.stringify(id)}, () => require(${JSON.stringify(id)})); c.v({ok:true});`,
      'res.end(JSON.stringify(R.m("probe").exports));');
    assert.deepEqual(result, { ok: true });
  });
}

test('dynamic platform external uses the runtime-provided binding', async t => {
  const result = await fixture(t,
    'c.v(() => c.y("cloudflare:workers"));',
    'const mod=await R.m("probe").exports();res.end(JSON.stringify({waitUntil:typeof mod.waitUntil}));');
  assert.deepEqual(result, { waitUntil: 'function' });
});

for (const first of ['node', 'workerd']) {
  test(`conditional exports follow package order: ${first} first`, async t => {
    const other = first === 'node' ? 'workerd' : 'node';
    const result = await fixture(t,
      'c.v(() => c.y("fixture-conditions"));',
      'res.end(JSON.stringify({value:(await R.m("probe").exports()).value}));',
      { 'fixture-conditions': {
        'package.json': JSON.stringify({ type: 'module', exports: { [first]: `./${first}.mjs`, [other]: `./${other}.mjs`, default: './node.mjs' } }),
        'node.mjs': 'export const value="node-import";',
        'workerd.mjs': 'export const value="workerd-import";',
      } });
    assert.equal(result.value, first + '-import');
  });
}

test('an unresolved resolve-only package still fails the build', async t => {
  await assert.rejects(fixture(t,
    'c.v(() => c.x.resolve("fixture-not-installed"));',
    'res.end(JSON.stringify(R.m("probe").exports()));'), /Could not resolve|Cannot statically link/);
});

test('late optional imports keep the source importer dependency policy', async t => {
  const result = await fixture(t,
    'const unused=()=>c.y("fixture-late-optional");c.v({ok:true});',
    'res.end(JSON.stringify(R.m("probe").exports));');
  assert.deepEqual(result, { ok: true });
});

test('executing an absent optional import still fails at runtime', async t => {
  await assert.rejects(fixture(t,
    'c.v(()=>c.y("fixture-late-optional"));',
    'res.end(JSON.stringify(await R.m("probe").exports()));'), /Failed to load external module fixture-late-optional/);
});

test('require, resolve metadata and dynamic import use their own export conditions', async t => {
  const result = await fixture(t,
    'const required=c.x("fixture-kinds",()=>require("fixture-kinds"));c.v(async()=>({required:required.value,file:c.x.resolve("fixture-kinds"),imported:(await c.y("fixture-kinds")).value}));',
    'res.end(JSON.stringify(await R.m("probe").exports()));',
    { 'fixture-kinds': {
      'package.json': JSON.stringify({ exports: { import: './import.mjs', require: './require.cjs' } }),
      'import.mjs': 'export const value="import";',
      'require.cjs': 'exports.value="require";',
    } });
  assert.equal(result.required, 'require');
  assert.equal(result.imported, 'import');
  assert.ok(result.file.endsWith('/node_modules/fixture-kinds/require.cjs'));
});
