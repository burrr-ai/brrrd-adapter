import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin } from "esbuild";

import type { CompatibilityPolicy } from "./types.js";

const INSTANCE_RE = /[\\/]next[\\/]dist[\\/]server[\\/]app-render[\\/]module-loading[\\/]track-module-loading\.instance\.js$/;

// Next's process-wide signal can retain an Immediate from another request.
// The current render's signal owns its timers and already tracks cache fills.
const REQUEST_SIGNAL = `const _workunit = require("../work-unit-async-storage.external");
function getModuleLoadingSignal() {
    const store = _workunit.workUnitAsyncStorage.getStore();
    return store ? _workunit.getCacheSignal(store) : null;
}
`;

function patchImportSignal(source: string): string {
  const start = source.indexOf('const _cachesignal = require("../cache-signal");');
  const end = source.indexOf("function trackPendingChunkLoad(promise)", start);
  const subscribe = source.indexOf("function trackPendingModules(cacheSignal)", end);
  const subscribeEnd = source.indexOf("\n}", subscribe) + 2;
  if (start < 0 || end < 0 || subscribe < 0
    || subscribeEnd < subscribe
    || !source.slice(start, end).includes("new _cachesignal.CacheSignal(null)")) {
    throw new Error("unsupported Next module-loading signal source");
  }
  const tracking = source.slice(end, subscribe);
  if (tracking.split("moduleLoadingSignal.trackRead(").length !== 3) {
    throw new Error("unsupported Next module-loading tracking calls");
  }
  const subscription = source.slice(subscribe, subscribeEnd);
  if (!subscription.includes("moduleLoadingSignal.subscribeToReads(cacheSignal)")
    || !subscription.includes("cacheSignal.cacheReady().then(unsubscribe)")) {
    throw new Error("unsupported Next module-loading subscription");
  }
  return source.slice(0, start) + REQUEST_SIGNAL
    + tracking.replaceAll("moduleLoadingSignal.trackRead(", "moduleLoadingSignal?.trackRead(")
    + `// Imports are registered directly with the current work-unit signal.
// A later render does not subscribe to another request's pending imports.
function trackPendingModules(_cacheSignal) {}
` + source.slice(subscribeEnd);
}

function createNextImportSignalPlugin(): Plugin {
  return {
    name: "brrrd-next-import-signal",
    setup(build) {
      build.onLoad({ filter: INSTANCE_RE }, (args) => ({
        contents: patchImportSignal(fs.readFileSync(args.path, "utf8")),
        loader: "js",
        resolveDir: path.dirname(args.path),
      }));
    },
  };
}

export const nextImportSignalPolicy: CompatibilityPolicy = {
  name: "next-import-signal",
  plugins: () => [createNextImportSignalPlugin()],
};
