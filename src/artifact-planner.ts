import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as zlib from "node:zlib";

import type { ManifestSupplement } from "./manifest-supplement.js";
import type { NextBuildModel, NormalizedOutput } from "./model.js";
import { requestOutputs } from "./model.js";
import {
  publicArtifactPathnames,
  publicStoragePackagePath,
} from "./public-storage.js";
import {
  findPrerenderOwner,
  isAuxiliaryPrerenderPath,
  isRouteHandlerPrerender,
} from "./prerender-classifier.js";
import type { BrrrdArtifact, BrrrdEdgeFunction } from "./types.js";
import { sanitizeId } from "./routing.js";

const require = createRequire(import.meta.url);

const COMPRESS_EXTENSIONS = new Set([
  "js", "mjs", "css", "html", "json", "svg", "txt", "map", "xml", "wasm",
]);
const COMPRESS_MIN_BYTES = 1024;

export type ArtifactPlanItem = BrrrdArtifact & {
  packagePath: string;
  sourceAbsPath?: string;
  precompress?: boolean;
};

export type ArtifactPlan = {
  items: ArtifactPlanItem[];
};

export type ArtifactCopySummary = {
  staticCount: number;
  prerenderCount: number;
  runtimeCount: number;
  middlewareCount: number;
  edgeFunctionCount: number;
  compressedCount: number;
};

function packageJoin(...parts: string[]): string {
  return path.posix.join(
    ...parts.map((part) => part.split(path.sep).join("/").replace(/^\/+/, "")),
  );
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function readJsonIfExists(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(src);
        continue;
      }
      if (entry.isFile()) out.push(src);
    }
  };
  walk(root);
  return out;
}

function isInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function nodeModulePackageRel(sourceAbsPath: string): string | null {
  const parts = sourceAbsPath.split(path.sep);
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] !== "node_modules") continue;
    const relParts = parts.slice(i + 1);
    if (relParts.length === 0 || relParts[0] === ".pnpm") continue;
    return relParts.join("/");
  }
  return null;
}

function sourceLabel(model: NextBuildModel, sourceAbsPath: string | undefined): string | undefined {
  if (!sourceAbsPath) return undefined;
  const relProject = path.relative(model.projectDir, sourceAbsPath);
  if (!relProject.startsWith("..")) return relProject.split(path.sep).join("/");
  const relDist = path.relative(model.distDir, sourceAbsPath);
  if (!relDist.startsWith("..")) return `.next/${relDist.split(path.sep).join("/")}`;
  return path.basename(sourceAbsPath);
}

function artifactItem(
  model: NextBuildModel,
  input: Omit<ArtifactPlanItem, "sourcePath">,
): ArtifactPlanItem {
  return {
    ...input,
    sourcePath: sourceLabel(model, input.sourceAbsPath),
  };
}

function staticArtifact(
  model: NextBuildModel,
  output: NormalizedOutput,
  allPublicPathnames: readonly string[],
): ArtifactPlanItem {
  if (!output.filePath) throw new Error(`missing filePath for static file ${output.pathname}`);
  const packagePath = packageJoin(
    "static",
    publicStoragePackagePath(output.pathname, allPublicPathnames),
  );
  return artifactItem(model, {
    id: `static:${sanitizeId(output.urlPath)}`,
    kind: output.kind === "public" ? "public" : "static",
    ownerRouteId: `static-${sanitizeId(output.urlPath)}`,
    sourceAbsPath: output.filePath,
    packagePath,
    mountPath: output.urlPath,
    immutable: !!output.immutableHash,
    required: true,
    reason: output.kind === "public"
      ? "project public/ file served by Next static layer"
      : "Next Adapter API staticFiles output",
    precompress: true,
  });
}

type PrerenderPublicArtifact = {
  sourceAbsPath: string;
  packagePath: string;
  mountPath: string;
  contentType?: string;
  reason: string;
};

function nextDataRoutePathname(
  model: NextBuildModel,
  pathname: string,
): string | null {
  const match = pathname.match(/^\/_next\/data\/([^/]+)\/(.+\.json)$/);
  if (!match) return null;
  if (match[1] !== model.buildId) return null;
  const rel = match[2];
  if (rel.split("/").some((segment) => segment === ".." || segment === "")) return null;
  return rel;
}

function prerenderHtmlArtifact(
  model: NextBuildModel,
  prerender: NormalizedOutput,
  allPublicPathnames: readonly string[],
): PrerenderPublicArtifact {
  const htmlName = prerender.pathname === "/"
    ? "index.html"
    : prerender.pathname.replace(/^\//, "") + ".html";
  const owner = findPrerenderOwner(model, prerender);
  const routeRoot = owner.kind === "page" ? "pages" : "app";
  const sourceAbsPath = prerender.filePath
    ? prerender.filePath
    : path.join(model.distDir, "server", routeRoot, htmlName);
  const destName = prerender.pathname === "/"
    ? "index"
    : publicStoragePackagePath(prerender.pathname, allPublicPathnames);
  return {
    sourceAbsPath,
    packagePath: packageJoin("static", destName),
    mountPath: prerender.pathname,
    reason: "static prerender HTML served without invoking the handler",
  };
}

function prerenderDataArtifact(
  model: NextBuildModel,
  prerender: NormalizedOutput,
  dataRel: string,
): PrerenderPublicArtifact {
  const sourceAbsPath = prerender.filePath
    ? prerender.filePath
    : path.join(model.distDir, "server", "pages", dataRel);
  return {
    sourceAbsPath,
    packagePath: packageJoin("static", prerender.pathname),
    mountPath: prerender.pathname,
    contentType: "application/json",
    reason: "Pages Router prerender data JSON served without invoking the handler",
  };
}

function prerenderPublicArtifact(
  model: NextBuildModel,
  prerender: NormalizedOutput,
  allPublicPathnames: readonly string[],
): PrerenderPublicArtifact | null {
  if (isAuxiliaryPrerenderPath(prerender.pathname)) return null;

  const dataRel = nextDataRoutePathname(model, prerender.pathname);
  if (dataRel) return prerenderDataArtifact(model, prerender, dataRel);
  if (isRouteHandlerPrerender(model, prerender)) return null;
  return prerenderHtmlArtifact(model, prerender, allPublicPathnames);
}

function prerenderArtifacts(model: NextBuildModel): ArtifactPlanItem[] {
  const items: ArtifactPlanItem[] = [];
  const allPublicPathnames = publicArtifactPathnames(model);
  for (const prerender of model.outputs.prerenders) {
    const artifact = prerenderPublicArtifact(model, prerender, allPublicPathnames);
    if (!artifact) continue;
    items.push(artifactItem(model, {
      id: `prerender:${sanitizeId(prerender.pathname)}`,
      kind: "prerender",
      ownerRouteId: `prerender-${sanitizeId(prerender.pathname)}`,
      sourceAbsPath: artifact.sourceAbsPath,
      packagePath: artifact.packagePath,
      mountPath: artifact.mountPath,
      ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
      required: true,
      reason: artifact.reason,
      precompress: true,
    }));
  }
  return items;
}

function runtimeManifestArtifacts(model: NextBuildModel): ArtifactPlanItem[] {
  const items: ArtifactPlanItem[] = [];
  const rootManifests = [
    "routes-manifest.json",
    "prerender-manifest.json",
    "build-manifest.json",
    "react-loadable-manifest.json",
    "required-server-files.json",
    "BUILD_ID",
  ];
  for (const name of rootManifests) {
    const sourceAbsPath = path.join(model.distDir, name);
    if (!fs.existsSync(sourceAbsPath)) continue;
    items.push(artifactItem(model, {
      id: `runtime-root:${name}`,
      kind: "runtime-manifest",
      sourceAbsPath,
      packagePath: packageJoin("runtime/.next", name),
      mountPath: packageJoin(".next", name),
      required: true,
      reason: "Next server code reads this root build manifest at runtime",
    }));
  }

  const serverManifests = [
    "next-font-manifest.json",
    "server-reference-manifest.json",
    "server-reference-manifest.js",
    "middleware-manifest.json",
  ];
  for (const name of serverManifests) {
    const sourceAbsPath = path.join(model.distDir, "server", name);
    if (!fs.existsSync(sourceAbsPath)) continue;
    items.push(artifactItem(model, {
      id: `runtime-server:${name}`,
      kind: "runtime-manifest",
      sourceAbsPath,
      packagePath: packageJoin("runtime/.next/server", name),
      mountPath: packageJoin(".next/server", name),
      required: true,
      reason: "Next server code reads this server manifest at runtime",
    }));
  }

  const sriSrc = path.join(model.distDir, "server", "subresource-integrity-manifest.json");
  if (fs.existsSync(sriSrc)) {
    items.push(artifactItem(model, {
      id: "runtime-server:subresource-integrity-manifest.json",
      kind: "runtime-manifest",
      sourceAbsPath: sriSrc,
      packagePath: "runtime/.next/server/subresource-integrity-manifest.json",
      mountPath: ".next/server/subresource-integrity-manifest.json",
      required: true,
      reason: "Next server code reads subresource integrity metadata at runtime",
    }));
  }

  return items;
}

function clientReferenceArtifacts(model: NextBuildModel): ArtifactPlanItem[] {
  const serverDir = path.join(model.distDir, "server");
  const appDir = path.join(serverDir, "app");
  if (!fs.existsSync(appDir)) return [];
  const items: ArtifactPlanItem[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(src);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith("_client-reference-manifest.js")) continue;
      const rel = path.relative(serverDir, src).split(path.sep).join("/");
      items.push(artifactItem(model, {
        id: `client-reference:${rel}`,
        kind: "runtime-manifest",
        sourceAbsPath: src,
        packagePath: packageJoin("runtime/.next/server", rel),
        mountPath: packageJoin(".next/server", rel),
        required: true,
        reason: "App Router client reference manifest for server rendering",
      }));
    }
  };
  walk(appDir);
  return items;
}

function appPrerenderRuntimeArtifacts(model: NextBuildModel): ArtifactPlanItem[] {
  const serverDir = path.join(model.distDir, "server");
  const appDir = path.join(serverDir, "app");
  if (!fs.existsSync(appDir)) return [];
  const items: ArtifactPlanItem[] = [];
  const shouldCopy = (filePath: string) => {
    const ext = path.extname(filePath);
    return ext === ".html" || ext === ".meta" || ext === ".rsc";
  };
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(src);
        continue;
      }
      if (!entry.isFile() || !shouldCopy(src)) continue;
      const rel = path.relative(serverDir, src).split(path.sep).join("/");
      items.push(artifactItem(model, {
        id: `app-prerender:${rel}`,
        kind: "runtime-file",
        sourceAbsPath: src,
        packagePath: packageJoin("runtime/.next/server", rel),
        mountPath: packageJoin(".next/server", rel),
        required: true,
        reason: "App Router prerender/PPR runtime artifact",
      }));
    }
  };
  walk(appDir);
  return items;
}

function routeRuntimeDependencyArtifacts(model: NextBuildModel): ArtifactPlanItem[] {
  const items: ArtifactPlanItem[] = [];
  const seenPackagePaths = new Set<string>();

  const add = (sourceAbsPath: string, owner: NormalizedOutput, reason: string) => {
    if (!isRegularFile(sourceAbsPath)) return;

    let rel: string;
    let packagePath: string;
    let mountPath: string;
    let artifactReason = reason;
    if (isInsideDir(sourceAbsPath, model.distDir)) {
      rel = path.relative(model.distDir, sourceAbsPath).split(path.sep).join("/");
      packagePath = packageJoin("runtime/.next", rel);
      mountPath = packageJoin(".next", rel);
    } else {
      const nodeRel = nodeModulePackageRel(sourceAbsPath);
      if (!nodeRel) return;
      rel = packageJoin("node_modules", nodeRel);
      packagePath = packageJoin("runtime", rel);
      mountPath = rel;
      artifactReason = `${reason} for server external require`;
    }

    if (seenPackagePaths.has(packagePath)) return;
    seenPackagePaths.add(packagePath);
    items.push(artifactItem(model, {
      id: `route-runtime:${sanitizeId(owner.id)}:${sanitizeId(rel)}`,
      kind: "runtime-file",
      ownerRouteId: sanitizeId(owner.id),
      sourceAbsPath,
      packagePath,
      mountPath,
      required: true,
      reason: artifactReason,
    }));
  };

  for (const output of requestOutputs(model)) {
    for (const sourceAbsPath of Object.values(output.assets)) {
      add(sourceAbsPath, output, "Next traced route runtime dependency");
    }

    if (!output.filePath) continue;
    const tracePath = `${output.filePath}.nft.json`;
    if (!fs.existsSync(tracePath)) continue;
    const trace = readJsonIfExists(tracePath);
    const files = Array.isArray(trace?.files) ? trace.files : [];
    const traceDir = path.dirname(tracePath);
    for (const rel of files) {
      if (typeof rel !== "string" || rel.length === 0) continue;
      add(path.resolve(traceDir, rel), output, "Next NFT route runtime dependency");
    }
  }

  return items;
}

function serverChunkGraphArtifacts(model: NextBuildModel): ArtifactPlanItem[] {
  const chunkRoot = path.join(model.distDir, "server", "chunks");
  const files = walkFiles(chunkRoot);
  return files.map((sourceAbsPath) => {
    const rel = path.relative(model.distDir, sourceAbsPath).split(path.sep).join("/");
    return artifactItem(model, {
      id: `server-chunk:${sanitizeId(rel)}`,
      kind: "runtime-file",
      sourceAbsPath,
      packagePath: packageJoin("runtime/.next", rel),
      mountPath: packageJoin(".next", rel),
      required: true,
      reason: "Next server runtime chunk graph",
    });
  });
}

function cacheHandlerArtifacts(model: NextBuildModel): ArtifactPlanItem[] {
  return ["cache-handler", "cache-handler-legacy"].map((variant) => {
    const sourceAbsPath = require.resolve(`@brrrd/adapter/${variant}`);
    return artifactItem(model, {
      id: `compat:${variant}`,
      kind: "compatibility",
      sourceAbsPath,
      packagePath: `runtime/brrrd-${variant}.mjs`,
      mountPath: `brrrd-${variant}.mjs`,
      required: true,
      reason: "brrrd cache handler polyfill configured by modifyConfig",
    });
  });
}

function middlewareArtifacts(
  model: NextBuildModel,
  supplement: ManifestSupplement,
): ArtifactPlanItem[] {
  const middleware = supplement.middleware;
  if (!middleware) return [];
  const refs = [
    ...middleware.files,
    ...middleware.wasm.map((file) => file.filePath),
    ...middleware.assets.map((file) => file.filePath),
  ];
  return uniqueStrings(refs).map((rel) => artifactItem(model, {
    id: `middleware:${rel}`,
    kind: "middleware",
    sourceAbsPath: path.join(model.distDir, rel),
    packagePath: packageJoin("runtime", rel),
    mountPath: rel,
    required: true,
    reason: "Next proxy/middleware compiled chunk or supporting asset",
  }));
}

function edgeFunctionArtifacts(
  model: NextBuildModel,
  edgeFunctions: Map<string, BrrrdEdgeFunction>,
): ArtifactPlanItem[] {
  const refs: string[] = [];
  for (const edgeFn of edgeFunctions.values()) {
    refs.push(
      ...edgeFn.files,
      ...edgeFn.wasm.map((file) => file.filePath),
      ...edgeFn.assets.map((file) => file.filePath),
    );
  }
  return uniqueStrings(refs).map((rel) => artifactItem(model, {
    id: `edge-function:${rel}`,
    kind: "edge-function",
    sourceAbsPath: path.join(model.distDir, rel),
    packagePath: packageJoin("runtime", rel),
    mountPath: rel,
    required: true,
    reason: "Next Edge app/page/API compiled chunk or supporting asset",
  }));
}

function appBundleArtifact(model: NextBuildModel, outDir: string): ArtifactPlanItem {
  return artifactItem(model, {
    id: "bundle:app",
    kind: "app-bundle",
    sourceAbsPath: path.join(outDir, "bundles", "app.js"),
    packagePath: "bundles/app.js",
    mountPath: "bundles/app.js",
    required: true,
    reason: "single brrrd app dispatcher bundle",
  });
}

function dedupePlanItems(items: ArtifactPlanItem[]): ArtifactPlanItem[] {
  const seen = new Set<string>();
  const out: ArtifactPlanItem[] = [];
  for (const item of items) {
    if (seen.has(item.packagePath)) continue;
    seen.add(item.packagePath);
    out.push(item);
  }
  return out;
}

export function createArtifactPlan(
  model: NextBuildModel,
  supplement: ManifestSupplement,
  edgeFunctions: Map<string, BrrrdEdgeFunction>,
  outDir: string,
  options: { hasAppBundle: boolean },
): ArtifactPlan {
  const allPublicPathnames = publicArtifactPathnames(model);
  return {
    items: dedupePlanItems([
      ...(options.hasAppBundle ? [appBundleArtifact(model, outDir)] : []),
      ...model.outputs.staticFiles.map((output) => (
        staticArtifact(model, output, allPublicPathnames)
      )),
      ...prerenderArtifacts(model),
      ...runtimeManifestArtifacts(model),
      ...clientReferenceArtifacts(model),
      ...appPrerenderRuntimeArtifacts(model),
      ...routeRuntimeDependencyArtifacts(model),
      ...serverChunkGraphArtifacts(model),
      ...cacheHandlerArtifacts(model),
      ...middlewareArtifacts(model, supplement),
      ...edgeFunctionArtifacts(model, edgeFunctions),
    ]),
  };
}

function copyFileStrict(src: string, dest: string, label: string): void {
  if (!fs.existsSync(src)) {
    throw new Error(`${label} does not exist: ${src}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function hasPrecompressedVariant(dest: string): boolean {
  return fs.existsSync(dest + ".br") || fs.existsSync(dest + ".gz");
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
    // Precompression is an optimization; failed gzip should not fail the build.
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
    // Precompression is an optimization; failed brotli should not fail the build.
  }
  return wrote;
}

function maybePrecompress(dest: string): boolean {
  const ext = path.extname(dest).slice(1).toLowerCase();
  if (!COMPRESS_EXTENSIONS.has(ext)) return false;
  const raw = fs.readFileSync(dest);
  if (raw.length < COMPRESS_MIN_BYTES) return false;
  return writePrecompressedVariants(dest, raw);
}

export function executeArtifactPlan(plan: ArtifactPlan, outDir: string): ArtifactCopySummary {
  const summary: ArtifactCopySummary = {
    staticCount: 0,
    prerenderCount: 0,
    runtimeCount: 0,
    middlewareCount: 0,
    edgeFunctionCount: 0,
    compressedCount: 0,
  };

  for (const item of plan.items) {
    const dest = path.join(outDir, item.packagePath);
    if (item.sourceAbsPath) {
      if (path.resolve(item.sourceAbsPath) !== path.resolve(dest)) {
        copyFileStrict(item.sourceAbsPath, dest, item.reason);
      } else if (item.required && !fs.existsSync(dest)) {
        throw new Error(`${item.reason} does not exist: ${dest}`);
      }
    } else if (item.required && !fs.existsSync(dest)) {
      throw new Error(`${item.reason} does not exist: ${dest}`);
    }

    if (item.precompress && item.sourceAbsPath) {
      const before = hasPrecompressedVariant(dest);
      if (maybePrecompress(dest) && !before) summary.compressedCount++;
    }

    switch (item.kind) {
      case "static":
      case "public":
        summary.staticCount++;
        break;
      case "prerender":
        summary.prerenderCount++;
        break;
      case "runtime-manifest":
      case "runtime-file":
      case "compatibility":
        summary.runtimeCount++;
        break;
      case "middleware":
        summary.middlewareCount++;
        break;
      case "edge-function":
        summary.edgeFunctionCount++;
        break;
      case "app-bundle":
        break;
    }
  }

  return summary;
}

export function manifestArtifacts(plan: ArtifactPlan): BrrrdArtifact[] {
  return plan.items.map((item) => ({
    id: item.id,
    kind: item.kind,
    ...(item.ownerRouteId ? { ownerRouteId: item.ownerRouteId } : {}),
    ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
    packagePath: item.packagePath,
    mountPath: item.mountPath,
    ...(item.contentType ? { contentType: item.contentType } : {}),
    ...(item.immutable !== undefined ? { immutable: item.immutable } : {}),
    required: item.required,
    reason: item.reason,
  }));
}
