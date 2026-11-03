import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { bundleAppHandler } from '../dist/bundler.js';
import { loadNativeBundle } from './fixtures/native-request-owner.mjs';

process.env.BRRRD_RUNTIME_ABI = 'workerd-node-v1';

test('Turbopack links lazy chunks, shared package identity, cycles and external imports without root hooks', async () => {
  assert.equal(globalThis.__brrrd_turbopack_runtime_root, undefined);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brrrd-turbopack-link-'));
  const distDir = path.join(root, '.next');
  const chunks = path.join(distDir, 'server/chunks/ssr');
  fs.mkdirSync(chunks, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'package.json'), '{"type":"commonjs"}');
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/turbopack-node-runtime.js', import.meta.url)), path.join(chunks, '[turbopack]_runtime.js'));
  for (const key of ['@next/cache-handlers', '@next/cache-handlers-map', '@next/cache-handlers-set']) delete globalThis[Symbol.for(key)];
  const shared = path.join(root, 'node_modules/fixture-shared');
  const dynamic = path.join(root, 'node_modules/fixture-dynamic');
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(dynamic, { recursive: true });
  fs.writeFileSync(path.join(shared, 'package.json'), '{"main":"index.cjs"}');
  fs.writeFileSync(path.join(shared, 'index.cjs'), 'globalThis.__brrrdLinkLoads = (globalThis.__brrrdLinkLoads || 0) + 1; module.exports = {};');
  fs.writeFileSync(path.join(dynamic, 'package.json'), JSON.stringify({ type: 'module', exports: { workerd: './workerd.mjs', default: './other.mjs' } }));
  fs.writeFileSync(path.join(dynamic, 'workerd.mjs'), 'export const value = "workerd-import";');
  fs.writeFileSync(path.join(dynamic, 'other.mjs'), 'throw new Error("wrong export condition");');
  fs.writeFileSync(path.join(chunks, 'a.js'), `module.exports = ["a", c => { const ordinary = { y: () => 1 }; ordinary.y("not-a-package"); const a = { shared: c.x("fixture-shared", () => require("fixture-shared")) }; c.v(a); a.peer = c.r("b"); }];`);
  fs.writeFileSync(path.join(chunks, 'b.js'), `module.exports = ["b", c => { const b = { shared: c.x("fixture-shared", () => require("fixture-shared")) }; c.v(b); b.peer = c.r("a"); }, "dynamic", c => { c.v(() => c.y("fixture-dynamic")); }];`);
  fs.writeFileSync(path.join(chunks, 'unused.js'), 'throw new Error("unused chunk evaluated eagerly");');
  const entry = path.join(distDir, 'server/entry.cjs');
  fs.writeFileSync(entry, `
const R = require('./chunks/ssr/[turbopack]_runtime.js')('server/entry.cjs');
R.c('server/chunks/ssr/a.js'); R.c('server/chunks/ssr/b.js');
exports.handler = async (_req, res) => {
  const a = R.m('a').exports, b = R.m('b').exports;
  const imported = await R.m('dynamic').exports();
  res.end(JSON.stringify({ shared: a.shared === b.shared, cycle: a.peer === b && b.peer === a, loads: globalThis.__brrrdLinkLoads, imported: imported.value }));
};`);
  try {
    const output = await bundleAppHandler([{ id: 'probe', filePath: entry }], { projectDir: root, distDir, outDir: path.join(root, 'out'), buildId: 'test' });
    const app = await loadNativeBundle(pathToFileURL(output));
    const response = { statusCode: 200, end(body) { this.body = body; } };
    await app.default('probe', { headers: { host: 'test' } }, response);
    assert.deepEqual(JSON.parse(response.body), { shared: true, cycle: true, loads: 1, imported: 'workerd-import' });
    assert.equal(globalThis.__brrrd_turbopack_runtime_root, undefined);
  } finally {
    delete globalThis.__brrrdLinkLoads;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
