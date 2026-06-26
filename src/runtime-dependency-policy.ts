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
  "tty", "perf_hooks", "diagnostics_channel", "module",
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

const EXTERNAL_IF_MISSING_PACKAGES = new Set<string>([
  ...EMPTY_STUB_OPTIONAL_PACKAGES,
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

function isInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isBarePackageSpecifier(specifier: string): boolean {
  if (specifier.length === 0) return false;
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("\0")) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) return false;
  return true;
}

function owningNodeModulePackage(filePath: string): string | null {
  const parts = filePath.split(path.sep);
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] !== "node_modules") continue;
    const first = parts[i + 1];
    if (!first || first === ".pnpm") continue;
    if (first.startsWith("@")) {
      const second = parts[i + 2];
      return second ? `${first}/${second}` : null;
    }
    return first;
  }
  return null;
}

function isNextGeneratedRuntimeImporter(importer: string, ctx: BuildContext): boolean {
  if (!importer) return false;
  if (isInsideDir(importer, ctx.distDir)) return true;
  return owningNodeModulePackage(importer) === "next";
}

function isNodeModuleRuntimeImporter(importer: string): boolean {
  return !!importer && owningNodeModulePackage(importer) !== null;
}

export function createRuntimeDependencyPlugin(ctx: BuildContext): Plugin {
  return {
    name: "brrrd-runtime-dependency-policy",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // Next can emit conditional runtime-only require() calls, such as the
        // Pages runtime CSS optimizer path. Preserve Node's late
        // MODULE_NOT_FOUND behavior for those generated/runtime files instead
        // of failing the adapter's esbuild pass.
        const lateRuntimeImport = isBarePackageSpecifier(args.path)
          && (
            args.kind === "require-call"
            || args.kind === "dynamic-import"
          )
          && (
            isNextGeneratedRuntimeImporter(args.importer, ctx)
            || isNodeModuleRuntimeImporter(args.importer)
          );
        const externalIfMissing = EXTERNAL_IF_MISSING_PACKAGES.has(args.path)
          || lateRuntimeImport;
        if (!externalIfMissing) return undefined;
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
var __brrrd_cjs_file_cache = Object.create(null);
function __brrrd_builtin_module(id) {
  var m = globalThis.__brrrd_modules && (globalThis.__brrrd_modules[id] || globalThis.__brrrd_modules["node:" + id]);
  return m ? (m.default !== undefined ? m.default : m) : null;
}
function __brrrd_package_parts(id) {
  var parts = String(id).split("/");
  if (parts[0] && parts[0][0] === "@") {
    if (parts.length < 2) return null;
    return { name: parts[0] + "/" + parts[1], subpath: parts.length > 2 ? "./" + parts.slice(2).join("/") : "." };
  }
  return { name: parts[0], subpath: parts.length > 1 ? "./" + parts.slice(1).join("/") : "." };
}
function __brrrd_export_target(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var arrayTarget = __brrrd_export_target(value[i]);
      if (arrayTarget) return arrayTarget;
    }
    return null;
  }
  if (value && typeof value === "object") {
    return __brrrd_export_target(value.require)
      || __brrrd_export_target(value.node)
      || __brrrd_export_target(value.default);
  }
  return null;
}
function __brrrd_export_map_target(exportsMap, subpath) {
  if (typeof exportsMap === "string" || Array.isArray(exportsMap)) {
    return subpath === "." ? __brrrd_export_target(exportsMap) : null;
  }
  if (!exportsMap || typeof exportsMap !== "object") return null;
  if (subpath === "." && !Object.prototype.hasOwnProperty.call(exportsMap, ".")) {
    var rootTarget = __brrrd_export_target(exportsMap);
    if (rootTarget) return rootTarget;
  }
  if (Object.prototype.hasOwnProperty.call(exportsMap, subpath)) {
    return __brrrd_export_target(exportsMap[subpath]);
  }
  for (var key in exportsMap) {
    if (key.indexOf("*") === -1) continue;
    var parts = key.split("*");
    if (parts.length !== 2 || !subpath.startsWith(parts[0]) || !subpath.endsWith(parts[1])) continue;
    var matched = subpath.slice(parts[0].length, subpath.length - parts[1].length);
    var patternTarget = __brrrd_export_target(exportsMap[key]);
    if (patternTarget && patternTarget.indexOf("*") !== -1) return patternTarget.replace("*", matched);
  }
  return null;
}
function __brrrd_file_candidates(path, base) {
  var candidates = [base];
  if (!/\\.c?js$/.test(base)) {
    candidates.push(base + ".js", base + ".cjs", path.join(base, "index.js"), path.join(base, "index.cjs"));
  }
  return candidates;
}
function __brrrd_pick_existing_file(fs, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (fs.existsSync(candidates[i]) && fs.statSync(candidates[i]).isFile()) return candidates[i];
    } catch (_e) {}
  }
  return null;
}
function __brrrd_resolve_package_export(fs, path, id) {
  if (id[0] === "/" || id[0] === ".") return null;
  var parts = __brrrd_package_parts(id);
  if (!parts || !parts.name) return null;
  var root = path.resolve(globalThis.__brrrd_node_modules_root || "/bundle/node_modules", parts.name);
  try {
    var pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    var target = __brrrd_export_map_target(pkg.exports, parts.subpath);
    if (!target || target[0] !== ".") return null;
    return __brrrd_pick_existing_file(fs, __brrrd_file_candidates(path, path.resolve(root, target)));
  } catch (_e) {
    return null;
  }
}
function __brrrd_resolve_cjs_file(id, baseDir) {
  if (typeof id !== "string" || id.length === 0) return null;
  var fs = __brrrd_builtin_module("fs");
  var path = __brrrd_builtin_module("path");
  if (!fs || !path) return null;
  var exportFile = __brrrd_resolve_package_export(fs, path, id);
  if (exportFile) return exportFile;
  var base = id[0] === "/"
    ? id
    : (id[0] === "."
      ? path.resolve(baseDir || "/bundle", id)
      : path.resolve(globalThis.__brrrd_node_modules_root || "/bundle/node_modules", id));
  var candidates = __brrrd_file_candidates(path, base);
  if (!/\\.c?js$/.test(base)) {
    try {
      var pkg = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
      if (pkg && typeof pkg.main === "string" && pkg.main.length > 0) {
        candidates.push(path.join(base, pkg.main));
      }
    } catch (_e) {}
  }
  return __brrrd_pick_existing_file(fs, candidates);
}
function __brrrd_load_cjs_file(file) {
  if (__brrrd_cjs_file_cache[file]) return __brrrd_cjs_file_cache[file].exports;
  var fs = __brrrd_builtin_module("fs");
  var path = __brrrd_builtin_module("path");
  if (!fs || !path) {
    var __brrrdFileErr = new Error("Cannot load runtime file '" + file + "' without fs/path builtins");
    __brrrdFileErr.code = "MODULE_NOT_FOUND";
    throw __brrrdFileErr;
  }
  var module = { exports: {} };
  __brrrd_cjs_file_cache[file] = module;
  var dirname = path.dirname(file);
  var localRequire = (childId) => {
    var resolved = __brrrd_resolve_cjs_file(String(childId), dirname);
    return resolved ? __brrrd_load_cjs_file(resolved) : require(childId);
  };
  localRequire.resolve = (childId) => {
    return __brrrd_resolve_cjs_file(String(childId), dirname) || String(childId);
  };
  var source = fs.readFileSync(file, "utf8");
  if (file.slice(-5) === ".json") {
    module.exports = JSON.parse(source);
    return module.exports;
  }
  var fn = new Function("exports", "module", "require", "__filename", "__dirname", source + "\\n//# sourceURL=file://" + file);
  fn(module.exports, module, localRequire, file, dirname);
  return module.exports;
}
function __brrrd_resolve_cjs_specifier(id, baseDir) {
  return __brrrd_resolve_cjs_file(String(id), baseDir || "/bundle") || String(id);
}
// Expose the CommonJS file loader/resolver globally so a synthetic ESM bridge
// (emitted by brrrd's module loader when a bare ESM import resolves to a
// CommonJS file, e.g. an externalized package's CJS leaf like ws/lib/*.js) can
// evaluate it through the SAME proven CJS machinery instead of failing native
// ESM/CJS interop. brrrd's loader calls __brrrd_load_cjs_file(absPath).
globalThis.__brrrd_load_cjs_file ??= __brrrd_load_cjs_file;
globalThis.__brrrd_resolve_cjs_file ??= __brrrd_resolve_cjs_file;
var require = globalThis.__brrrd_require || ((id) => {
  var m = globalThis.__brrrd_modules && globalThis.__brrrd_modules[id];
  if (m) {
    var r = m.default !== undefined ? m.default : m;
    if ((id === "util" || id === "node:util") && !r.TextEncoder) {
      r = Object.assign({}, r, { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder });
    }
    return r;
  }
  if (id === "module" || id === "node:module") {
    function normalizeBuiltinId(x) { return String(x).startsWith("node:") ? String(x).slice(5) : String(x); }
    function isBuiltin(x) {
      var n = normalizeBuiltinId(x);
      return !!(globalThis.__brrrd_modules && (globalThis.__brrrd_modules[n] || globalThis.__brrrd_modules["node:" + n]));
    }
    function Module() {}
    Module.createRequire = () => require;
    Module.prototype.require = require;
    Module._resolveFilename = (r) => __brrrd_resolve_cjs_specifier(r, "/bundle");
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
  var resolvedFile = __brrrd_resolve_cjs_file(id, "/bundle");
  if (resolvedFile) return __brrrd_load_cjs_file(resolvedFile);
  if (id === "@opentelemetry/api") return ${OTEL_STUB_SOURCE};
  var optionalEmptyModules = new Set(${emptyStubOptionalPackages});
  if (optionalEmptyModules.has(id)) {
    console.warn("[brrrd] require: optional module '" + id + "', returning empty stub");
    return {};
  }
  var __brrrdErr = new Error("Cannot find module '" + id + "' ([brrrd] unsupported/unbundled require)");
  __brrrdErr.code = "MODULE_NOT_FOUND";
  throw __brrrdErr;
});
require.resolve = (id) => __brrrd_resolve_cjs_specifier(id, "/bundle");
// Expose the assembled require so the synthetic ESM->CJS bridge can fall back to
// it (builtins, optional stubs) for ids that are not concrete files on disk.
globalThis.__brrrd_require ??= require;
var __filename = "/bundle/handler.js";
var __dirname = "/bundle";
globalThis.__brrrd_turbopack_runtime_root ??= "/bundle/.next";
globalThis.__brrrd_turbopack_dist_root ??= "/bundle";
globalThis.__brrrd_node_modules_root ??= "/bundle/node_modules";

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
