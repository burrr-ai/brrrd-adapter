import * as esbuild from "esbuild";
import * as path from "node:path";
import * as fs from "node:fs";
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

  const moduleEntries = outputs
    .map((o) => `  '${o.id}': () => Promise.resolve().then(() => require('${o.filePath}'))`)
    .join(",\n");

  const dispatcherCode = `
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
      loader: {
        ".wasm": "binary",
      },
      external: runtimeDependencyExternals(),
      banner: {
        js: runtimeRequireBanner(),
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
      mainFields: ["module", "main"],
      conditions: ["node", "import"],
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
