import * as esbuild from "esbuild";
import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import type { BuildContext } from "./types.js";
import { OTEL_STUB_SOURCE } from "./otel-stub.js";

// All node: modules that brrrd provides at runtime (external for esbuild).
// Listed once; both bare and "node:" prefixed forms are generated.
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
];
const BRRRD_EXTERNALS = [
  ...BRRRD_NODE_MODULES,
  ...BRRRD_NODE_MODULES.map((m) => `node:${m}`),
  // Optional deps that Next.js references but aren't always installed
  "@opentelemetry/api",
  "@opentelemetry/sdk-trace-base",
];

const NEXT_OG_IMPORT_RE = /^(next\/og|next\/dist\/api\/og|next\/dist\/server\/og\/image-response(?:\.js)?)$/;
const NEXT_OG_NODE_ENTRY = "next/dist/compiled/@vercel/og/index.node.js";
const NEXT_OG_NODE_ENTRY_RE = /next[\\/]dist[\\/]compiled[\\/]@vercel[\\/]og[\\/]index\.node\.js$/;
const NEXT_OG_SHIM_NAMESPACE = "brrrd-next-og";
const NEXT_OG_SHARP_NAMESPACE = "brrrd-next-og-sharp";

const NEXT_OG_SHIM_SOURCE = `
function importModule() {
  return import("${NEXT_OG_NODE_ENTRY}");
}

export class ImageResponse extends Response {
  static displayName = "ImageResponse";

  constructor(...args) {
    const readable = new ReadableStream({
      async start(controller) {
        const OGImageResponse = (await importModule()).ImageResponse;
        const imageResponse = new OGImageResponse(...args);
        if (!imageResponse.body) {
          controller.close();
          return;
        }
        const reader = imageResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        }
      },
    });
    const options = args[1] || {};
    const headers = new Headers({
      "content-type": "image/png",
      "cache-control": process.env.NODE_ENV === "development"
        ? "no-cache, no-store"
        : "public, max-age=0, must-revalidate",
    });
    if (options.headers) {
      const newHeaders = new Headers(options.headers);
      newHeaders.forEach((value, key) => headers.set(key, value));
    }
    super(readable, {
      headers,
      status: options.status,
      statusText: options.statusText,
    });
  }
}
`;

function normalizePathForMatch(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function resolveFromProject(ctx: BuildContext, specifier: string): string {
  const projectRequire = createRequire(path.join(ctx.projectDir, "package.json"));
  try {
    return projectRequire.resolve(specifier);
  } catch {
    return createRequire(import.meta.url).resolve(specifier);
  }
}

function isNextOgNodeEntry(filePath: string): boolean {
  return NEXT_OG_NODE_ENTRY_RE.test(normalizePathForMatch(filePath));
}

function createNextOgPlugin(ctx: BuildContext): esbuild.Plugin {
  return {
    name: "brrrd-next-og",
    setup(build) {
      build.onResolve({ filter: NEXT_OG_IMPORT_RE }, () => ({
        path: "image-response",
        namespace: NEXT_OG_SHIM_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: NEXT_OG_SHIM_NAMESPACE }, () => ({
        contents: NEXT_OG_SHIM_SOURCE,
        loader: "js",
        resolveDir: ctx.projectDir,
      }));
      build.onResolve({ filter: /^next\/dist\/compiled\/@vercel\/og\/index\.node\.js$/ }, (args) => ({
        path: resolveFromProject(ctx, args.path),
      }));
      build.onResolve({ filter: /^sharp$/ }, (args) => {
        if (!isNextOgNodeEntry(args.importer)) return undefined;
        return {
          path: "sharp",
          namespace: NEXT_OG_SHARP_NAMESPACE,
        };
      });
      build.onLoad({ filter: /.*/, namespace: NEXT_OG_SHARP_NAMESPACE }, () => ({
        contents: "export default undefined;\n",
        loader: "js",
      }));
    },
  };
}

function metafileUsesNextOgNode(metafile: esbuild.Metafile | undefined): boolean {
  return Object.keys(metafile?.inputs ?? {}).some(isNextOgNodeEntry);
}

function copyNextOgNodeAssets(ctx: BuildContext): void {
  const copied: string[] = [];
  for (const name of ["Geist-Regular.ttf", "resvg.wasm"]) {
    const src = resolveFromProject(ctx, `next/dist/compiled/@vercel/og/${name}`);
    const dest = path.join(ctx.outDir, "bundles", name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push(name);
  }
  console.log(`  Copied next/og WASM fallback assets: ${copied.join(", ")}`);
}

// require() shim for ESM bundles running in brrrd's V8 Isolate.
// Next.js turbopack runtime uses CJS require() internally even though we
// bundle as ESM. This shim resolves node: built-in modules from brrrd's
// globalThis.__brrrd_modules registry (populated by node_init.js).
// OTel stub 은 별도 otel-stub.ts 모듈에서 import (TD-11).
const REQUIRE_BANNER = `
var require = globalThis.__brrrd_require || ((id) => {
  var m = globalThis.__brrrd_modules && globalThis.__brrrd_modules[id];
  if (m) {
    var r = m.default !== undefined ? m.default : m;
    // Patch: Node.js util exports TextEncoder/TextDecoder (used by React DOM)
    if ((id === "util" || id === "node:util") && !r.TextEncoder) {
      r = Object.assign({}, r, { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder });
    }
    return r;
  }
  // OpenTelemetry API stub — Next.js tracer requires it but it's optional
  if (id === "@opentelemetry/api") return ${OTEL_STUB_SOURCE};
  // node:module stub — Next.js uses Module.createRequire() and Module.prototype.require
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
  var optionalEmptyModules = new Set([
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
  ]);
  if (optionalEmptyModules.has(id)) {
    console.warn("[brrrd] require: optional module '" + id + "', returning empty stub");
    return {};
  }
  // Node-shaped not-found error: keep the loud brrrd marker for debugging, but
  // set code = MODULE_NOT_FOUND so callers that probe for it (e.g. Next's
  // optional instrumentation-hook require) degrade gracefully instead of
  // crashing the page. Mirrors the dev bridge (js-dev/bridge.js __notFound).
  var __brrrdErr = new Error("Cannot find module '" + id + "' ([brrrd] unsupported/unbundled require)");
  __brrrdErr.code = "MODULE_NOT_FOUND";
  throw __brrrdErr;
});
require.resolve = (id) => id;
var __filename = "/bundle/handler.js";
var __dirname = "/bundle";

// Force Node-style timer handles for Next 16 cacheComponents atomic-timer
// probing. esbuild may otherwise resolve bare setTimeout to deno_web's
// numeric-id implementation, which makes the bundle's \`"_idleStart" in
// handle\` check throw with TypeError.
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

/**
 * Compute esbuild nodePaths from adapter output assets.
 * Accepts one or more asset maps (Record<relPath, absPath> from @vercel/nft).
 * Extracts unique parent directories so esbuild can resolve them.
 */
function computeNodePaths(
  assetMaps: (Record<string, string> | undefined)[],
  ctx: BuildContext,
): string[] {
  const dirs = new Set<string>();
  dirs.add(ctx.distDir);
  dirs.add(path.join(ctx.distDir, "server"));
  for (const assets of assetMaps) {
    if (assets) {
      for (const absPath of Object.values(assets)) {
        dirs.add(path.dirname(absPath));
      }
    }
  }
  return Array.from(dirs);
}

/**
 * Bundle all route handlers into a single app dispatcher.
 * Generates: dispatch(routeId, req, res) that routes to the correct handler.
 */
export async function bundleAppHandler(
  outputs: Array<{
    id: string;
    filePath: string;
    assets?: Record<string, string>;
  }>,
  ctx: BuildContext,
): Promise<string> {
  const outfile = path.join(ctx.outDir, "bundles", "app.js");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });

  const imports = outputs
    .map((o, i) => `import * as mod_${i} from '${o.filePath}';`)
    .join("\n");

  const moduleEntries = outputs
    .map((o, i) => `  '${o.id}': mod_${i}`)
    .join(",\n");

  const dispatcherCode = `
${imports}

const routeModules = {
${moduleEntries}
};

const resolvedHandlers = new Map();

async function resolveHandler(routeId) {
  if (resolvedHandlers.has(routeId)) return resolvedHandlers.get(routeId);

  const mod = routeModules[routeId];
  if (!mod) return null;

  let target = mod.handler ?? mod.default ?? mod;
  target = await target;

  if (target && typeof target !== 'function') {
    target = target.handler ?? target.default ?? target;
    target = await target;
  }

  if (typeof target !== 'function') {
    throw new TypeError('Route handler for ' + routeId + ' is not callable');
  }

  resolvedHandlers.set(routeId, target);
  return target;
}

export default async function dispatch(routeId, req, res) {
  const h = await resolveHandler(routeId);
  if (!h) { res.writeHead(404); res.end('Not Found'); return; }
  const brrrdRequestMeta = req.__brrrd_request_meta || {};
  const ctx = {
    waitUntil: (p) => {
      Deno.core.ops.op_brrrd_wait_until_start(globalThis.__brrrd_realm_id);
      Promise.resolve(p)
        .catch(e => console.error('[waitUntil]', e))
        .finally(() => Deno.core.ops.op_brrrd_wait_until_end(globalThis.__brrrd_realm_id));
    },
    requestMeta: {
      ...brrrdRequestMeta,
      relativeProjectDir: '.',
      hostname: req.headers?.host || 'localhost',
    },
  };
  return h(req, res, ctx);
}
`;

  try {
    const result = await esbuild.build({
      stdin: {
        contents: dispatcherCode,
        resolveDir: ctx.projectDir,
        loader: "js",
      },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "esnext",
      outfile,
      external: BRRRD_EXTERNALS,
      banner: {
        js: REQUIRE_BANNER,
      },
      metafile: true,
      plugins: [createNextOgPlugin(ctx)],
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.NEXT_RUNTIME": '"nodejs"',
      },
      logLevel: "warning",
      mainFields: ["module", "main"],
      conditions: ["node", "import"],
      nodePaths: computeNodePaths(outputs.map((o) => o.assets), ctx),
    });
    if (metafileUsesNextOgNode(result.metafile)) {
      copyNextOgNodeAssets(ctx);
    }
  } catch (e) {
    console.error("Failed to bundle app handler:", e);
    throw e;
  }

  return outfile;
}

// bundleEdgeHandler removed — all routes use Node.js runtime.
// bundleMiddleware removed — Next compiled proxy/middleware entries are webpack
// chunks, so re-bundling with esbuild breaks them. build.ts raw-copies the edge
// runtime chunk plus the proxy/middleware entry chunk into runtime/server/.
