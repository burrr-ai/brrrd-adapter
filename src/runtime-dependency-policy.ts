import type { Plugin } from "esbuild";
import { createRequire } from "node:module";
import * as path from "node:path";

import { OTEL_STUB_SOURCE } from "./otel-stub.js";
import type { BuildContext } from "./types.js";

const require = createRequire(import.meta.url);

const BRRRD_NODE_MODULES = [
  "fs", "fs/promises", "path", "buffer", "crypto",
  "stream", "stream/web", "stream/promises",
  "events", "process", "util", "url", "zlib",
  "http", "https", "os", "async_hooks",
  "string_decoder", "querystring", "assert",
  "timers", "timers/promises", "constants",
  "net", "tls", "dns", "child_process", "vm",
  "http2", "readline", "worker_threads",
  "perf_hooks", "diagnostics_channel", "module",
] as const;

const RUNTIME_PROVIDED_EXTERNALS = [
  ...BRRRD_NODE_MODULES,
  ...BRRRD_NODE_MODULES.map((moduleName) => `node:${moduleName}`),
];

const ALWAYS_EXTERNAL_PACKAGES = [
  "@opentelemetry/api",
  "@opentelemetry/sdk-trace-base",
] as const;

const EMPTY_STUB_OPTIONAL_PACKAGES = [
  "encoding",
  "pnpapi",
  "bufferutil",
  "utf-8-validate",
  "inspector",
  "node:inspector",
  "perf_hooks",
  "node:perf_hooks",
  "diagnostics_channel",
  "node:diagnostics_channel",
] as const;

const MODULE_NOT_FOUND_OPTIONAL_PACKAGES = [
  "critters",
] as const;

const EXTERNAL_IF_MISSING_PACKAGES = new Set<string>([
  ...EMPTY_STUB_OPTIONAL_PACKAGES,
  ...MODULE_NOT_FOUND_OPTIONAL_PACKAGES,
]);

export function runtimeDependencyExternals(): string[] {
  return [
    ...RUNTIME_PROVIDED_EXTERNALS,
    ...ALWAYS_EXTERNAL_PACKAGES,
  ];
}

function resolveSearchPaths(ctx: BuildContext, resolveDir: string): string[] {
  return Array.from(new Set([
    resolveDir,
    ctx.projectDir,
    ctx.distDir,
    path.join(ctx.distDir, "server"),
  ].filter(Boolean)));
}

function canResolveFromBuild(specifier: string, ctx: BuildContext, resolveDir: string): boolean {
  try {
    require.resolve(specifier, { paths: resolveSearchPaths(ctx, resolveDir) });
    return true;
  } catch {
    return false;
  }
}

export function createRuntimeDependencyPlugin(ctx: BuildContext): Plugin {
  return {
    name: "brrrd-runtime-dependency-policy",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!EXTERNAL_IF_MISSING_PACKAGES.has(args.path)) return undefined;
        if (canResolveFromBuild(args.path, ctx, args.resolveDir)) return undefined;
        return {
          path: args.path,
          external: true,
        };
      });
    },
  };
}

export function runtimeRequireBanner(): string {
  const emptyStubOptionalPackages = JSON.stringify(EMPTY_STUB_OPTIONAL_PACKAGES);
  return `
var require = globalThis.__brrrd_require || ((id) => {
  var m = globalThis.__brrrd_modules && globalThis.__brrrd_modules[id];
  if (m) {
    var r = m.default !== undefined ? m.default : m;
    if ((id === "util" || id === "node:util") && !r.TextEncoder) {
      r = Object.assign({}, r, { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder });
    }
    return r;
  }
  if (id === "@opentelemetry/api") return ${OTEL_STUB_SOURCE};
  if (id === "module" || id === "node:module") {
    function normalizeBuiltinId(x) { return String(x).startsWith("node:") ? String(x).slice(5) : String(x); }
    function isBuiltin(x) {
      var n = normalizeBuiltinId(x);
      return !!(globalThis.__brrrd_modules && (globalThis.__brrrd_modules[n] || globalThis.__brrrd_modules["node:" + n]));
    }
    function Module() {}
    Module.createRequire = () => require;
    Module.prototype.require = require;
    Module._resolveFilename = (r) => r;
    Module._load = (r) => require(r);
    Module._cache = {};
    Module.builtinModules = Array.from(new Set(Object.keys(globalThis.__brrrd_modules || {}).map(normalizeBuiltinId))).sort();
    Module.findSourceMap = () => undefined;
    Module.isBuiltin = isBuiltin;
    Module.syncBuiltinESMExports = () => {};
    Module.Module = Module;
    Module.prototype = { require: require, constructor: Module };
    return Module;
  }
  var optionalEmptyModules = new Set(${emptyStubOptionalPackages});
  if (optionalEmptyModules.has(id)) {
    console.warn("[brrrd] require: optional module '" + id + "', returning empty stub");
    return {};
  }
  var __brrrdErr = new Error("Cannot find module '" + id + "' ([brrrd] unsupported/unbundled require)");
  __brrrdErr.code = "MODULE_NOT_FOUND";
  throw __brrrdErr;
});
require.resolve = (id) => id;
var __filename = "/bundle/handler.js";
var __dirname = "/bundle";
globalThis.__brrrd_turbopack_runtime_root ??= "/bundle/.next";
globalThis.__brrrd_turbopack_dist_root ??= "/bundle";

var __brrrd_timers = (globalThis.__brrrd_modules && (globalThis.__brrrd_modules['node:timers'] || globalThis.__brrrd_modules['timers'])) || null;
if (__brrrd_timers) {
  globalThis.setTimeout = __brrrd_timers.setTimeout;
  globalThis.clearTimeout = __brrrd_timers.clearTimeout;
  globalThis.setInterval = __brrrd_timers.setInterval;
  globalThis.clearInterval = __brrrd_timers.clearInterval;
}
var setTimeout = globalThis.setTimeout;
var clearTimeout = globalThis.clearTimeout;
var setInterval = globalThis.setInterval;
var clearInterval = globalThis.clearInterval;
`;
}
