import * as esbuild from "esbuild";
import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import {
  createCompatibilityPlugins,
  runCompatibilityAfterBundle,
} from "./compatibility/index.js";
import { nextServerDefineEnv } from "./next-config.js";
import { materializeSupportFile } from "./config.js";
import {
  createRuntimeDependencyPlugin,
  runtimeDependencyExternals,
  runtimeRequireBanner,
} from "./runtime-dependency-policy.js";
import type { BuildContext } from "./types.js";

const require = createRequire(import.meta.url);

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

function resolveModulePath(specifier: string, ctx: BuildContext): string {
  let resolved: string;
  try {
    resolved = require.resolve(specifier, {
      paths: [
        ctx.projectDir,
        ctx.distDir,
        path.join(ctx.distDir, "server"),
      ],
    });
  } catch {
    resolved = require.resolve(specifier);
  }
  return resolved;
}

const exposeNextAppRenderStoragesFooter = `
try {
  globalThis.__brrrd_next_app_render_async_storages = {
    actionAsyncStorage: require_action_async_storage_external().actionAsyncStorage,
    workAsyncStorage: require_work_async_storage_external().workAsyncStorage,
    workUnitAsyncStorage: require_work_unit_async_storage_external().workUnitAsyncStorage,
  };
} catch (_) {
  // Some app bundles do not include App Router render storage externals.
}
`;

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
  nodeProxy?: { filePath: string; assets?: Record<string, string> },
): Promise<string> {
  const outfile = path.join(ctx.outDir, "bundles", "app.js");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });

  const moduleEntries = outputs
    .map((o) => `  '${o.id}': () => Promise.resolve().then(() => require('${o.filePath}'))`)
    .join(",\n");
  const nextEnvironmentBaseline = resolveModulePath("next/dist/server/node-environment-baseline", ctx);
  const nextCacheHandlersModule = resolveModulePath("next/dist/server/use-cache/handlers", ctx);
  const nextTagsManifestModule = resolveModulePath("next/dist/server/lib/incremental-cache/tags-manifest.external", ctx);
  // Keep one runtime module identity for publication across dispatcher and lazy Next imports.
  const cacheModule = materializeSupportFile(path.join(ctx.outDir, "runtime"), "cache-handler");
  const legacyModule = materializeSupportFile(path.join(ctx.outDir, "runtime"), "cache-handler-legacy");
  const brrrdCacheHandlerModule = "./" + path.relative(path.dirname(outfile), cacheModule).split(path.sep).join("/");
  const brrrdLegacyCacheHandlerModule = "./" + path.relative(path.dirname(outfile), legacyModule).split(path.sep).join("/");

  const dispatcherCode = `
// Next requires its official baseline before modules capture AsyncLocalStorage.
import ${JSON.stringify(nextEnvironmentBaseline)};
import { waitUntil as __brrrdRuntimeWaitUntil } from 'cloudflare:workers';
import * as __brrrdNextCacheHandlers from ${JSON.stringify(nextCacheHandlersModule)};
import { tagsManifest as __brrrdNextTagsManifest } from ${JSON.stringify(nextTagsManifestModule)};
import __brrrdCacheHandler, { createCacheBinding as __brrrdCacheBinding, ownRequestWork as __brrrdOwnWork, configureNativeCacheHandler as __brrrdConfigureCacheOwner } from ${JSON.stringify(brrrdCacheHandlerModule)};
import __brrrdLegacyCacheHandler, { configureNativeLegacyCacheHandler as __brrrdConfigureLegacyOwner } from ${JSON.stringify(brrrdLegacyCacheHandlerModule)};

// The injected function resolves the current IoContext at call time. No request
// ExecutionContext or ALS store is retained in this module-level owner.
__brrrdConfigureCacheOwner(__brrrdRuntimeWaitUntil);
__brrrdConfigureLegacyOwner(__brrrdRuntimeWaitUntil);

const routeLoaders = {
${moduleEntries}
};
const loadNodeProxy = ${nodeProxy ? `() => Promise.resolve().then(() => require(${JSON.stringify(nodeProxy.filePath)}))` : "null"};
let nodeProxyHandler;
async function resolveNodeProxy() {
  if (!loadNodeProxy) return null;
  if (!nodeProxyHandler) {
    const mod = await loadNodeProxy();
    // Next16's generated named handler takes a Web Request and context.
    // Its default export is the lower-level adapter(options), a different ABI.
    if (typeof mod.handler !== 'function') {
      throw new TypeError('Next Node proxy output requires handler(Request, context)');
    }
    nodeProxyHandler = mod.handler;
  }
  return nodeProxyHandler;
}
export async function proxy(request, _env, ctx, requestMeta) {
  const handler = await resolveNodeProxy();
  if (!handler) throw new Error('No Node proxy in this artifact');
  return handler(request, {
    signal: request.signal,
    waitUntil: promise => { __brrrdOwnWork(__brrrdRuntimeWaitUntil, promise); },
    requestMeta,
  });
}

const resolvedHandlers = new Map();

async function resolveHandler(routeId) {
  if (resolvedHandlers.has(routeId)) return resolvedHandlers.get(routeId);

  const loadRoute = routeLoaders[routeId];
  if (!loadRoute) return null;

  const mod = await loadRoute();
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

let brrrdCacheHandlersReady;

async function ensureBrrrdCacheHandlers() {
  if (!brrrdCacheHandlersReady) {
    brrrdCacheHandlersReady = (async () => {
      // The native profile owns its real backend/budget; no JS memory fallback is initialized.
      globalThis.__brrrd_next_cache_tags_manifest = __brrrdNextTagsManifest;
      const registryKey = Symbol.for('@next/cache-handlers');
      const registry = globalThis[registryKey] || {};
      for (const [name, handler] of Object.entries({
        DefaultCache: __brrrdCacheHandler, RemoteCache: __brrrdCacheHandler,
        FetchCache: __brrrdLegacyCacheHandler,
      })) {
        if (registry[name] && registry[name] !== handler) {
          throw new Error('unsupported competing Next cache handler: ' + name);
        }
        registry[name] = handler;
      }
      globalThis[registryKey] = registry;
      __brrrdNextCacheHandlers.initializeCacheHandlers(0);
      const entries = Array.from(__brrrdNextCacheHandlers.getCacheHandlerEntries() || []);
      const writers = Array.from(__brrrdNextCacheHandlers.getCacheHandlers() || []);
      if (entries.length !== 2 || !entries.every(([kind, handler]) =>
        (kind === 'default' || kind === 'remote') && handler === __brrrdCacheHandler)
        || writers.length !== 1 || writers[0] !== __brrrdCacheHandler) {
        throw new Error('unsupported preinitialized Next cache publication writer');
      }
    })();
  }
  return brrrdCacheHandlersReady;
}

function requestMetaPath(req, relative) {
  const distDir = req.__brrrd_request_meta?.distDir;
  if (typeof distDir !== 'string' || !distDir.startsWith('/')) {
    throw new TypeError('native Next distDir metadata is required');
  }
  return require('path').join(distDir, relative);
}

// Public artifact bootstrap: real module imports, without a fabricated request event.
export async function initialize() {
  await ensureBrrrdCacheHandlers();
  for (const routeId of Object.keys(routeLoaders)) await resolveHandler(routeId);
  await resolveNodeProxy();
}

export default async function dispatch(routeId, req, res) {
  await ensureBrrrdCacheHandlers();
  const h = await resolveHandler(routeId);
  if (!h) { res.writeHead(404); res.end('Not Found'); return; }
  const brrrdRequestMeta = req.__brrrd_request_meta || {};
  const waitUntil = (p) => {
    __brrrdOwnWork(__brrrdRuntimeWaitUntil, p);
  };
  const createContext = (requestMetaOverrides = {}) => {
    const requestMeta = {
      ...brrrdRequestMeta,
      ...requestMetaOverrides,
      relativeProjectDir: '.',
      distDir: brrrdRequestMeta.distDir,
      hostname: req.headers?.host || 'localhost',
      minimalMode: brrrdRequestMeta.minimalMode === true,
    };
    delete requestMeta.pprFallbackRouteParams;
    requestMeta.render404 = async (renderReq = req, renderRes = res) => {
      const errorHandler = await resolveHandler('_error');
      renderRes.statusCode = 404;
      if (!errorHandler) {
        renderRes.end('This page could not be found');
        return;
      }
      return errorHandler(renderReq, renderRes, createContext());
    };
    requestMeta.revalidate = ({ urlPath }) => {
      const work = (async () => {
        if (!urlPath || typeof urlPath !== 'string') {
          throw new Error('brrrd revalidate requires a urlPath');
        }
        await __brrrdCacheBinding(req.cloudflare?.env?.BRRRD_CACHE).revalidatePath(urlPath);
      })();
      return __brrrdOwnWork(__brrrdRuntimeWaitUntil, work);
    };
    return {
      waitUntil,
      requestMeta,
    };
  };
  const ctx = createContext();
  try {
    return await h(req, res, ctx);
  } catch (err) {
    if (
      routeId === '500' ||
      routeId === '_error' ||
      String(routeId).startsWith('_next-data-') ||
      res.writableEnded ||
      res.finished ||
      res.headersSent
    ) {
      throw err;
    }

    const errorHandler = await resolveHandler('500');
    const genericErrorHandler = await resolveHandler('_error');
    if (!errorHandler && !genericErrorHandler) {
      throw err;
    }

    res.statusCode = 500;
    if (errorHandler) {
      if (genericErrorHandler) {
        await genericErrorHandler(
          req,
          res,
          createContext({ customErrorRender: true, invokeError: err }),
        );
        res.statusCode = 500;
      }
      return errorHandler(req, res, createContext({ invokeError: err }));
    }

    // No JS '500' handler: a custom 500 page may be a prebuilt STATIC page
    // (pages/500.html). brrrd invokes page handlers directly and has no
    // base-server findPageComponents('/500'); serve the static custom 500 from
    // the runtime fs, mirroring Next's base-server requirePage('/500') path,
    // before falling back to the default _error page.
    try {
      const fs = require('fs');
      const pagesManifest = JSON.parse(
        fs.readFileSync(requestMetaPath(req, 'server/pages-manifest.json'), 'utf8'),
      );
      const staticErrorPage = pagesManifest['/500'];
      if (typeof staticErrorPage === 'string' && staticErrorPage.endsWith('.html')) {
        const html = fs.readFileSync(requestMetaPath(req, 'server/' + staticErrorPage));
        if (!res.headersSent) {
          res.setHeader('content-type', 'text/html; charset=utf-8');
        }
        res.end(html);
        return;
      }
    } catch (_e) {
      // Fall through to the default _error page below.
    }

    return genericErrorHandler(req, res, createContext({ invokeError: err }));
  }
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
      loader: {
        ".wasm": "binary",
        ".map": "js",
      },
      external: [...runtimeDependencyExternals(), 'cloudflare:workers', brrrdCacheHandlerModule, brrrdLegacyCacheHandlerModule],
      banner: {
        js: runtimeRequireBanner(),
      },
      footer: {
        js: exposeNextAppRenderStoragesFooter,
      },
      metafile: true,
      plugins: [
        createRuntimeDependencyPlugin(ctx),
        ...createCompatibilityPlugins(ctx),
      ],
      define: nextServerDefineEnv(ctx.config),
      logLevel: "warning",
      mainFields: ["main", "module"],
      conditions: ["workerd", "node"],
      nodePaths: computeNodePaths([...outputs.map((o) => o.assets), nodeProxy?.assets], ctx),
    });
    runCompatibilityAfterBundle(ctx, result.metafile);
  } catch (e) {
    console.error("Failed to bundle app handler:", e);
    throw e;
  }

  return outfile;
}

// Node proxy's official Web handler is bundled with the Node dispatcher above.
