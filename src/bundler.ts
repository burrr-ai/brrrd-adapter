import * as esbuild from "esbuild";
import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import {
  createCompatibilityPlugins,
  runCompatibilityAfterBundle,
} from "./compatibility/index.js";
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
): Promise<string> {
  const outfile = path.join(ctx.outDir, "bundles", "app.js");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });

  const moduleEntries = outputs
    .map((o) => `  '${o.id}': () => Promise.resolve().then(() => require('${o.filePath}'))`)
    .join(",\n");
  const nextCacheHandlersModule = resolveModulePath("next/dist/server/use-cache/handlers", ctx);
  const nextTagsManifestModule = resolveModulePath("next/dist/server/lib/incremental-cache/tags-manifest.external", ctx);
  const brrrdCacheHandlerModule = resolveModulePath("@brrrd/adapter/cache-handler", ctx);

  const dispatcherCode = `
import * as __brrrdNextCacheHandlers from ${JSON.stringify(nextCacheHandlersModule)};
import { tagsManifest as __brrrdNextTagsManifest } from ${JSON.stringify(nextTagsManifestModule)};
import __brrrdCacheHandler from ${JSON.stringify(brrrdCacheHandlerModule)};

const routeLoaders = {
${moduleEntries}
};

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
      let cacheMaxMemorySize = 50 * 1024 * 1024;
      try {
        const fs = require('fs');
        const serverFiles = JSON.parse(fs.readFileSync('/bundle/runtime/.next/required-server-files.json', 'utf8'));
        if (typeof serverFiles?.config?.cacheMaxMemorySize === 'number') {
          cacheMaxMemorySize = serverFiles.config.cacheMaxMemorySize;
        }
      } catch (_) {
        // Synthetic build contexts may not include Next's full server-file manifest.
      }

      globalThis.__brrrd_next_cache_tags_manifest = __brrrdNextTagsManifest;
      __brrrdNextCacheHandlers.initializeCacheHandlers(cacheMaxMemorySize);
      __brrrdNextCacheHandlers.setCacheHandler('default', __brrrdCacheHandler);
    })();
  }
  return brrrdCacheHandlersReady;
}

const fallbackRouteParamTypeMap = {
  catchall: 'c',
  'catchall-intercepted-(..)(..)': 'ci(..)(..)',
  'catchall-intercepted-(.)': 'ci(.)',
  'catchall-intercepted-(..)': 'ci(..)',
  'catchall-intercepted-(...)': 'ci(...)',
  'optional-catchall': 'oc',
  dynamic: 'd',
  'dynamic-intercepted-(..)(..)': 'di(..)(..)',
  'dynamic-intercepted-(.)': 'di(.)',
  'dynamic-intercepted-(..)': 'di(..)',
  'dynamic-intercepted-(...)': 'di(...)',
};

function createBrrrdOpaqueFallbackRouteParams(fallbackRouteParams) {
  if (!Array.isArray(fallbackRouteParams) || fallbackRouteParams.length === 0) return null;
  const uniqueID = Math.random().toString(16).slice(2);
  const out = new Map();
  for (const param of fallbackRouteParams) {
    const paramName = typeof param?.paramName === 'string' ? param.paramName : '';
    const paramType = typeof param?.paramType === 'string' ? param.paramType : '';
    const shortType = fallbackRouteParamTypeMap[paramType];
    if (!paramName || !shortType) {
      throw new Error('Unsupported Next fallback route param: ' + JSON.stringify(param));
    }
    out.set(paramName, ['%%drp:' + paramName + ':' + uniqueID + '%%', shortType]);
  }
  return out.size > 0 ? out : null;
}

export default async function dispatch(routeId, req, res) {
  await ensureBrrrdCacheHandlers();
  const h = await resolveHandler(routeId);
  if (!h) { res.writeHead(404); res.end('Not Found'); return; }
  const brrrdRequestMeta = req.__brrrd_request_meta || {};
  const waitUntil = (p) => {
      Deno.core.ops.op_brrrd_wait_until_start(globalThis.__brrrd_realm_id);
      Promise.resolve(p)
        .catch(e => console.error('[waitUntil]', e))
        .finally(() => Deno.core.ops.op_brrrd_wait_until_end(globalThis.__brrrd_realm_id));
    };
  const createContext = (requestMetaOverrides = {}) => {
    const requestMeta = {
      ...brrrdRequestMeta,
      ...requestMetaOverrides,
      relativeProjectDir: '.',
      distDir: '/bundle/.next',
      hostname: req.headers?.host || 'localhost',
      minimalMode: brrrdRequestMeta.minimalMode === true,
    };
    const pprFallbackRouteParams = requestMeta.pprFallbackRouteParams;
    delete requestMeta.pprFallbackRouteParams;
    if (!requestMeta.fallbackParams) {
      const fallbackParams = createBrrrdOpaqueFallbackRouteParams(pprFallbackRouteParams);
      if (fallbackParams) requestMeta.fallbackParams = fallbackParams;
    }
    requestMeta.render404 = async (renderReq = req, renderRes = res) => {
      const errorHandler = await resolveHandler('_error');
      renderRes.statusCode = 404;
      if (!errorHandler) {
        renderRes.end('This page could not be found');
        return;
      }
      return errorHandler(renderReq, renderRes, createContext());
    };
    requestMeta.revalidate = async ({ urlPath }) => {
      if (!urlPath || typeof urlPath !== 'string') {
        throw new Error('brrrd revalidate requires a urlPath');
      }
      const ops = globalThis.Deno?.core?.ops;
      if (!ops || typeof ops.op_brrrd_cache_revalidate_path !== 'function') {
        throw new Error('brrrd cache revalidate path op is unavailable');
      }
      await ops.op_brrrd_cache_revalidate_path(urlPath);
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
      external: runtimeDependencyExternals(),
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
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.NEXT_RUNTIME": '"nodejs"',
      },
      logLevel: "warning",
      mainFields: ["main", "module"],
      conditions: ["node"],
      nodePaths: computeNodePaths(outputs.map((o) => o.assets), ctx),
    });
    runCompatibilityAfterBundle(ctx, result.metafile);
  } catch (e) {
    console.error("Failed to bundle app handler:", e);
    throw e;
  }

  return outfile;
}

// bundleMiddleware removed — Next compiled proxy/middleware and Edge route
// entries are already runtime-shaped chunks. Re-bundling them with esbuild
// breaks Next's registration format, so build.ts raw-copies the manifest-listed
// files into runtime/server/.
