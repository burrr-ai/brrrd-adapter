import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

import { nextImportSignalPolicy } from '../dist/compatibility/next-import-signal.js';

const require = createRequire(import.meta.url);
const instancePath = require.resolve('next/dist/server/app-render/module-loading/track-module-loading.instance');
const source = fs.readFileSync(instancePath, 'utf8');

function transform(file) {
  let load;
  nextImportSignalPolicy.plugins({})[0].setup({ onLoad(options, callback) {
    assert.ok(options.filter.test(file));
    load = callback;
  } });
  return load({ path: file }).contents;
}

test('module loading uses only the current work-unit signal and never subscribes to another request', async () => {
  const patched = transform(instancePath);
  assert.doesNotMatch(patched, /_moduleLoadingSignal|subscribeToReads|setImmediate|setTimeout/);
  const storage = new AsyncLocalStorage();
  const calls = [];
  const exports = {};
  vm.runInNewContext(patched, {
    exports, Promise,
    require(id) {
      assert.equal(id, '../work-unit-async-storage.external');
      return { workUnitAsyncStorage: storage, getCacheSignal: store => store.cacheSignal };
    },
  });
  const a = { cacheSignal: { trackRead(promise) { calls.push(['A', promise]); } } };
  const b = { cacheSignal: { trackRead(promise) { calls.push(['B', promise]); } } };
  let release;
  const shared = new Promise(resolve => { release = resolve; });
  storage.run(a, () => exports.trackPendingImport(shared));
  storage.run(b, () => {
    exports.trackPendingModules({ subscribeToReads() { throw Error('foreign subscription'); } });
    exports.trackPendingChunkLoad(shared);
    exports.trackPendingImport({ synchronous: true });
  });
  assert.deepEqual(calls, [['A', shared], ['B', shared]]);
  // A cached Promise is not implicitly enrolled in a later work unit.
  storage.run(b, () => exports.trackPendingModules({}));
  assert.equal(calls.length, 2);
  exports.trackPendingImport(shared);
  storage.run({}, () => exports.trackPendingImport(shared));
  assert.equal(calls.length, 2);
  release();
  await shared;
});

test('module loading patch rejects source drift and preserves trailing source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brrrd-import-signal-'));
  const file = path.join(root, 'node_modules/next/dist/server/app-render/module-loading/track-module-loading.instance.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, source + '\nexports.extra = 42;\n');
    assert.match(transform(file), /exports.extra = 42/);
    fs.writeFileSync(file, source.replaceAll('moduleLoadingSignal.trackRead(', 'moduleLoadingSignal.changed('));
    assert.throws(() => transform(file), /unsupported Next module-loading tracking/);
    fs.writeFileSync(file, source.replace('new _cachesignal.CacheSignal(null)', 'new ChangedSignal()'));
    assert.throws(() => transform(file), /unsupported Next module-loading signal/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the current render waits for its tracked import before declaring cache readiness', async () => {
  const { CacheSignal } = require('next/dist/server/app-render/cache-signal');
  const storage = new AsyncLocalStorage();
  const exports = {};
  vm.runInNewContext(transform(instancePath), {
    exports, Promise,
    require: () => ({ workUnitAsyncStorage: storage, getCacheSignal: store => store.cacheSignal }),
  });
  const signal = new CacheSignal(null);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let ready = false;
  storage.run({ cacheSignal: signal }, () => exports.trackPendingImport(pending));
  const readiness = signal.cacheReady().then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(signal.count, 1);
  assert.equal(ready, false);
  release();
  await readiness;
  assert.equal(signal.count, 0);
  assert.equal(ready, true);
});
