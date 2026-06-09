import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as zlib from "node:zlib";

const require = createRequire(import.meta.url);
import { bundleAppHandler } from "./bundler.js";
import {
  extractMiddlewareMeta,
  extractPprPages,
  extractRoutingRules,
  writeManifest,
} from "./manifest.js";
import type { BrrrdMiddleware } from "./types.js";
import {
  convertRoutes,
  listPrerenderPathnames,
  prerenderStaticFile,
  sanitizeId,
} from "./routing.js";
import type { BuildContext } from "./types.js";

// TD-14: pre-compress text-based static assets with gzip/brotli at build time.
// The runtime's handle_static inspects Accept-Encoding and picks the derived file.
const COMPRESS_EXTENSIONS = new Set([
  "js", "mjs", "css", "html", "json", "svg", "txt", "map", "xml", "wasm",
]);
const COMPRESS_MIN_BYTES = 1024;

type AdapterOutput = {
  id: string;
  pathname: string;
  runtime?: string;
  filePath?: string;
  assets?: Record<string, string>;
  immutableHash?: string;
};

type AdapterBuildContext = {
  routing: unknown;
  outputs: {
    pages: AdapterOutput[];
    appPages: AdapterOutput[];
    appRoutes: AdapterOutput[];
    pagesApi: AdapterOutput[];
    middleware?: unknown;
    prerenders: Array<AdapterOutput & { fallback?: { filePath: string } }>;
    staticFiles: AdapterOutput[];
  };
  projectDir: string;
  repoRoot: string;
  distDir: string;
  config: unknown;
  nextVersion: string;
  buildId: string;
};

function copyFileStrict(src: string, dest: string, label: string): void {
  if (!fs.existsSync(src)) {
    throw new Error(`${label} does not exist: ${src}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function isNativeBinding(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".node";
}

function assertNoNativeBindings(outputs: AdapterOutput[]): void {
  const nativeFiles: string[] = [];
  for (const output of outputs) {
    if (output.filePath && isNativeBinding(output.filePath)) {
      nativeFiles.push(output.filePath);
    }
    for (const assetPath of Object.values(output.assets ?? {})) {
      if (isNativeBinding(assetPath)) nativeFiles.push(assetPath);
    }
  }
  if (nativeFiles.length > 0) {
    throw new Error(
      `native Node addons (.node) are not supported in brrrd isolates:\n${nativeFiles.map((file) => `  - ${file}`).join("\n")}`,
    );
  }
}

function writePrecompressedVariants(dest: string, raw: Buffer): boolean {
  let wrote = false;
  try {
    const gz = zlib.gzipSync(raw, { level: 9 });
    if (gz.length < raw.length) {
      fs.writeFileSync(dest + ".gz", gz);
      wrote = true;
    }
  } catch (_e) {
    // ignore
  }
  try {
    const br = zlib.brotliCompressSync(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
    if (br.length < raw.length) {
      fs.writeFileSync(dest + ".br", br);
      wrote = true;
    }
  } catch (_e) {
    // ignore
  }
  return wrote;
}

function hasPrecompressedVariant(dest: string): boolean {
  return fs.existsSync(dest + ".br") || fs.existsSync(dest + ".gz");
}

function maybePrecompress(dest: string): boolean {
  const ext = path.extname(dest).slice(1).toLowerCase();
  if (!COMPRESS_EXTENSIONS.has(ext)) return false;
  const raw = fs.readFileSync(dest);
  if (raw.length < COMPRESS_MIN_BYTES) return false;
  return writePrecompressedVariants(dest, raw);
}

function maybePrecompressRaw(dest: string): boolean {
  const raw = fs.readFileSync(dest);
  if (raw.length < COMPRESS_MIN_BYTES) return false;
  return writePrecompressedVariants(dest, raw);
}

function copyStaticFiles(ctx: AdapterBuildContext, outDir: string): {
  staticCount: number;
  compressedCount: number;
} {
  let staticCount = 0;
  let compressedCount = 0;
  for (const file of ctx.outputs.staticFiles) {
    const dest = path.join(outDir, "static", file.pathname);
    if (!file.filePath) throw new Error(`missing filePath for static file ${file.pathname}`);
    copyFileStrict(file.filePath, dest, `static file ${file.pathname}`);
    staticCount++;
    const before = hasPrecompressedVariant(dest);
    if (maybePrecompress(dest) && !before) {
      compressedCount++;
    }
  }
  return { staticCount, compressedCount };
}

// Next's adapter `outputs.staticFiles` does NOT include the project's `public/`
// directory (Next serves those via its own static layer, separate from build
// outputs). Scan `public/` here so those files get a static route + get copied
// into the package — otherwise every asset under public/ 404s on brrrd.
function collectPublicFiles(projectDir: string): AdapterOutput[] {
  const publicDir = path.join(projectDir, "public");
  if (!fs.existsSync(publicDir) || !fs.statSync(publicDir).isDirectory()) return [];
  const collected: AdapterOutput[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(publicDir, abs).split(path.sep).join("/");
      const pathname = "/" + rel;
      collected.push({ id: `public-${sanitizeId(pathname)}`, pathname, filePath: abs });
    }
  };
  walk(publicDir);
  return collected;
}

function copyPrerenders(ctx: AdapterBuildContext, outDir: string): number {
  let prerenderCount = 0;
  const prerenderPaths = listPrerenderPathnames(ctx.outputs.prerenders);
  for (const prerender of ctx.outputs.prerenders) {
    if (
      prerender.pathname.includes(".rsc") ||
      prerender.pathname.includes(".segment") ||
      prerender.pathname.includes("[")
    ) continue;

    const htmlName = prerender.pathname === "/" ? "index.html"
      : prerender.pathname.replace(/^\//, "") + ".html";
    const htmlPath = prerender.filePath ?? path.join(ctx.distDir, "server/app", htmlName);

    const destName = prerender.pathname === "/"
      ? "index"
      : prerenderStaticFile(prerender.pathname, prerenderPaths);
    const dest = path.join(outDir, "static", destName);
    copyFileStrict(htmlPath, dest, `prerender ${prerender.pathname}`);
    maybePrecompressRaw(dest);
    prerenderCount++;
  }
  return prerenderCount;
}

function copyCacheHandlerPolyfills(runtimeDir: string): void {
  for (const variant of ["cache-handler", "cache-handler-legacy"]) {
    const src = require.resolve(`@brrrd/adapter/${variant}`);
    const dest = path.join(runtimeDir, `brrrd-${variant}.mjs`);
    copyFileStrict(src, dest, `brrrd ${variant} polyfill`);
    console.log(`  Copied brrrd ${variant} polyfill`);
  }
}

function copyClientReferenceManifests(
  ctx: AdapterBuildContext,
  runtimeDir: string,
): number {
  const serverDir = path.join(ctx.distDir, "server");
  const appDir = path.join(serverDir, "app");
  if (!fs.existsSync(appDir)) return 0;

  let runtimeCount = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(src);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith("_client-reference-manifest.js")) {
        continue;
      }

      const rel = path.relative(serverDir, src);
      copyFileStrict(
        src,
        path.join(runtimeDir, ".next", "server", rel),
        `client reference manifest ${rel}`,
      );
      runtimeCount++;
    }
  };
  walk(appDir);
  return runtimeCount;
}

function copyRuntimeManifests(
  ctx: AdapterBuildContext,
  runtimeDir: string,
  allOutputs: AdapterOutput[],
): number {
  fs.mkdirSync(path.join(runtimeDir, ".next", "server"), { recursive: true });
  copyCacheHandlerPolyfills(runtimeDir);

  const rootManifests = [
    "routes-manifest.json",
    "prerender-manifest.json",
    "build-manifest.json",
    "react-loadable-manifest.json",
    "required-server-files.json",
    "BUILD_ID",
  ];
  let runtimeCount = 0;
  for (const name of rootManifests) {
    const src = path.join(ctx.distDir, name);
    if (fs.existsSync(src)) {
      copyFileStrict(src, path.join(runtimeDir, ".next", name), `runtime manifest ${name}`);
      runtimeCount++;
    }
  }

  const serverManifests = [
    "next-font-manifest.json",
    "server-reference-manifest.json",
    "server-reference-manifest.js",
    "middleware-manifest.json",
  ];
  for (const name of serverManifests) {
    const src = path.join(ctx.distDir, "server", name);
    if (fs.existsSync(src)) {
      copyFileStrict(
        src,
        path.join(runtimeDir, ".next", "server", name),
        `server runtime manifest ${name}`,
      );
      runtimeCount++;
    }
  }

  runtimeCount += copyClientReferenceManifests(ctx, runtimeDir);

  const sriSrc = path.join(ctx.distDir, "server", "subresource-integrity-manifest.json");
  if (fs.existsSync(sriSrc)) {
    copyFileStrict(
      sriSrc,
      path.join(runtimeDir, ".next", "server", "subresource-integrity-manifest.json"),
      "subresource integrity manifest",
    );
    runtimeCount++;
  }
  return runtimeCount;
}

function copyMiddlewareBundle(
  ctx: AdapterBuildContext,
  runtimeDir: string,
): BrrrdMiddleware | undefined {
  const mwMeta = extractMiddlewareMeta(ctx.distDir);
  if (!mwMeta) return undefined;
  const copyMiddlewareFile = (rel: string) => {
    const src = path.join(ctx.distDir, rel);
    const dest = path.join(runtimeDir, rel);
    copyFileStrict(src, dest, `middleware file ${rel}`);
  };
  copyMiddlewareFile(mwMeta.runtimeRel);
  copyMiddlewareFile(mwMeta.entryRel);
  for (const file of [...mwMeta.wasm, ...mwMeta.assets]) {
    copyMiddlewareFile(file.filePath);
  }
  console.log(
    `  Middleware bundles copied: ${mwMeta.runtimeRel}, ${mwMeta.entryRel} (${mwMeta.matchers.length} matchers, ${mwMeta.wasm.length} wasm, ${mwMeta.assets.length} assets)`,
  );
  return {
    runtime: mwMeta.runtimeRel,
    entry: mwMeta.entryRel,
    name: mwMeta.name,
    page: mwMeta.page,
    matchers: mwMeta.matchers,
    wasm: mwMeta.wasm,
    assets: mwMeta.assets,
    env: mwMeta.env,
  };
}

export async function onBuildComplete(ctx: AdapterBuildContext): Promise<void> {
  const outDir = path.join(ctx.projectDir, "dist", "brrrd");

  // Clean previous build
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "bundles"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "static"), { recursive: true });

  const buildCtx: BuildContext = {
    projectDir: ctx.projectDir,
    distDir: ctx.distDir,
    outDir,
    buildId: ctx.buildId,
  };

  console.log(`[@brrrd/adapter] Building for brrrd runtime...`);
  console.log(`  Project: ${ctx.projectDir}`);
  console.log(`  Next.js: ${ctx.nextVersion}`);
  console.log(`  Build ID: ${ctx.buildId}`);

  // 1. Bundle all handlers into a single app dispatcher
  const allOutputs = [
    ...ctx.outputs.appPages,
    ...ctx.outputs.appRoutes,
    ...ctx.outputs.pages,
    ...ctx.outputs.pagesApi,
  ];
  assertNoNativeBindings([
    ...allOutputs,
    ...ctx.outputs.prerenders,
    ...ctx.outputs.staticFiles,
  ]);

  const nodeOutputs = allOutputs
    .filter((o): o is AdapterOutput & { filePath: string } => typeof o.filePath === "string")
    .map((o) => ({ ...o, id: sanitizeId(o.id) }));

  if (nodeOutputs.length > 0) {
    await bundleAppHandler(nodeOutputs, buildCtx);
    console.log(`  Bundled ${nodeOutputs.length} handlers into app.js`);
  }

  // 1b. Merge public/ files into staticFiles so they get routes + are copied.
  // Dedup against existing static files and page handler paths to avoid clashes
  // (e.g. an app-router robots.ts that already owns /robots.txt).
  const takenPaths = new Set<string>([
    ...ctx.outputs.staticFiles.map((f) => f.pathname),
    ...allOutputs.map((o) => o.pathname),
  ]);
  let publicCount = 0;
  for (const publicFile of collectPublicFiles(ctx.projectDir)) {
    if (takenPaths.has(publicFile.pathname)) continue;
    takenPaths.add(publicFile.pathname);
    ctx.outputs.staticFiles.push(publicFile);
    publicCount++;
  }
  if (publicCount > 0) console.log(`  Registered ${publicCount} public/ files`);

  // 2. Copy static files (+ optional gzip/brotli precompression)
  const { staticCount, compressedCount } = copyStaticFiles(ctx, outDir);
  console.log(`  Copied ${staticCount} static files (${compressedCount} precompressed)`);

  // 2b. Copy prerender HTML to static dir (served as static content)
  const prerenderCount = copyPrerenders(ctx, outDir);
  console.log(`  Copied ${prerenderCount} prerenders`);

  // 3. Copy Next.js runtime manifests (needed by handler at runtime via fs.readFileSync)
  const runtimeDir = path.join(outDir, "runtime");
  const runtimeCount = copyRuntimeManifests(ctx, runtimeDir, allOutputs);
  console.log(`  Copied ${runtimeCount} runtime manifests`);

  // 4. Generate routes
  const routes = convertRoutes(ctx);

  // 5. Build env vars
  const env: Record<string, string> = {
    NODE_ENV: "production",
    NEXT_RUNTIME: "nodejs",
    __NEXT_PRIVATE_PREBUNDLED_REACT: "next",
  };

  // 6. Extract redirects/rewrites
  const { redirects, rewrites } = extractRoutingRules(ctx.distDir);
  if (redirects.length > 0 || rewrites.length > 0) {
    console.log(`  Routing rules: ${redirects.length} redirects, ${rewrites.length} rewrites`);
  }

  // 7. Middleware detection + raw copy
  // Next's compiled middleware bundle is in webpack chunk format — never
  // re-bundle it with esbuild. Copy the raw file as-is into runtime/server/,
  // then the isolate evaluates it on top of the edge runtime polyfill.
  const middleware = copyMiddlewareBundle(ctx, runtimeDir);

  // 8. PPR detection
  const pprPages = extractPprPages(ctx.distDir);
  if (pprPages.length > 0) {
    console.log(`  PPR enabled for ${pprPages.length} page(s): ${pprPages.join(", ")}`);
  }

  // 9. Write manifest
  writeManifest(outDir, ctx.buildId, routes, env, redirects, rewrites, middleware, pprPages);
  console.log(`  Manifest written to ${path.join(outDir, "manifest.json")}`);
  console.log(`[@brrrd/adapter] Done!`);
}
