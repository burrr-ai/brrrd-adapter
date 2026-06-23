import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as zlib from "node:zlib";

import type {
  ManifestSupplement,
  SupplementDynamicPrerenderRoute,
  SupplementStaticResponseMeta,
} from "./manifest-supplement.js";
import type { NextBuildModel, NormalizedOutput } from "./model.js";
import { requestOutputs } from "./model.js";
import {
  publicArtifactPathnames,
  publicStoragePackagePath,
} from "./public-storage.js";
import {
  findPrerenderOwner,
  isAuxiliaryPrerenderPath,
  isDynamicPrerenderTemplatePath,
  isRouteHandlerPrerender,
} from "./prerender-classifier.js";
import type { BrrrdArtifact, BrrrdEdgeFunction, BrrrdMiddleware } from "./types.js";
import { sanitizeId } from "./routing.js";
import {
  isPagesRscFallbackOutput,
  pagesStaticDataJson,
  pagesStaticDataPathname,
  pagesStaticDynamicDataMountPath,
} from "./pages-static-data.js";
import {
  pagesDynamicFallbackPublicPathnames,
  pagesDynamicFallbackShell,
} from "./pages-dynamic-prerender.js";
import { basePath } from "./next-config.js";

const require = createRequire(import.meta.url);

const COMPRESS_EXTENSIONS = new Set([
  "js", "mjs", "css", "html", "json", "svg", "txt", "map", "xml", "wasm", "rsc",
]);
const COMPRESS_MIN_BYTES = 1024;

export type ArtifactPlanItem = BrrrdArtifact & {
  packagePath: string;
  sourceAbsPath?: string;
  generatedContent?: string | Buffer;
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

function headerValue(headers: readonly { key: string; value: string }[], name: string): string | undefined {
  const match = headers.find((header) => header.key.toLowerCase() === name.toLowerCase());
  return match?.value;
}

function staticResponseMetaByPathname(
  metas: readonly SupplementStaticResponseMeta[] | undefined,
): Map<string, SupplementStaticResponseMeta> {
  const out = new Map<string, SupplementStaticResponseMeta>();
  for (const meta of metas ?? []) out.set(meta.pathname, meta);
  return out;
}

function inferredNextStaticContentType(output: NormalizedOutput): string | undefined {
  if (output.kind === "public") return undefined;
  if (!output.pathname.includes("[") || !output.filePath?.endsWith(".html")) return undefined;
  return "text/html; charset=utf-8";
}

function staticArtifact(
  model: NextBuildModel,
  output: NormalizedOutput,
  allPublicPathnames: readonly string[],
  responseMeta?: SupplementStaticResponseMeta,
): ArtifactPlanItem {
  if (!output.filePath) throw new Error(`missing filePath for static file ${output.pathname}`);
  const packagePath = packageJoin(
    "static",
    publicStoragePackagePath(output.pathname, allPublicPathnames),
  );
  const contentType = responseMeta
    ? headerValue(responseMeta.headers, "content-type")
    : inferredNextStaticContentType(output);
  return artifactItem(model, {
    id: `static:${sanitizeId(output.urlPath)}`,
    kind: output.kind === "public" ? "public" : "static",
    ownerRouteId: `static-${sanitizeId(output.urlPath)}`,
    sourceAbsPath: output.filePath,
    packagePath,
    mountPath: output.urlPath,
    ...(contentType ? { contentType } : {}),
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
  const sourcePathname = stripBasePathForSource(model, pathname);
  const match = sourcePathname.match(/^\/_next\/data\/([^/]+)\/(.+\.json)$/);
  if (!match) return null;
  if (match[1] !== model.buildId) return null;
  const rel = match[2];
  if (rel.split("/").some((segment) => segment === ".." || segment === "")) return null;
  return rel;
}

function stripBasePathForSource(model: NextBuildModel, pathname: string): string {
  const configured = basePath(model.config);
  if (!configured) return pathname;
  if (pathname === configured) return "/";
  const prefix = `${configured}/`;
  return pathname.startsWith(prefix) ? `/${pathname.slice(prefix.length)}` : pathname;
}

function prerenderHtmlArtifact(
  model: NextBuildModel,
  prerender: NormalizedOutput,
  allPublicPathnames: readonly string[],
): PrerenderPublicArtifact {
  const owner = findPrerenderOwner(model, prerender);
  const routeRoot = owner.kind === "page" ? "pages" : "app";
  const sourcePathname = stripBasePathForSource(model, prerender.pathname);
  const htmlName = sourcePathname === "/"
    ? "index.html"
    : sourcePathname.replace(/^\//, "") + ".html";
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
    contentType: "text/html; charset=utf-8",
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

function routeHandlerPrerenderArtifact(
  model: NextBuildModel,
  prerender: NormalizedOutput,
  allPublicPathnames: readonly string[],
  responseMeta?: SupplementStaticResponseMeta,
): PrerenderPublicArtifact | null {
  const sourceAbsPath = prerender.filePath
    ?? (responseMeta?.sourceRel
      ? path.join(
        model.distDir,
        "server",
        "app",
        responseMeta.sourceRel.endsWith(".meta")
          ? responseMeta.sourceRel.slice(0, -".meta".length) + ".body"
          : responseMeta.sourceRel,
      )
      : null);
  if (!sourceAbsPath) return null;
  return {
    sourceAbsPath,
    packagePath: packageJoin("static", publicStoragePackagePath(prerender.pathname, allPublicPathnames)),
    mountPath: prerender.pathname,
    ...(responseMeta ? { contentType: headerValue(responseMeta.headers, "content-type") } : {}),
    reason: "static route-handler prerender response served without invoking the handler",
  };
}

function prerenderPublicArtifact(
  model: NextBuildModel,
  prerender: NormalizedOutput,
  allPublicPathnames: readonly string[],
  dynamicPrerenderRoutes: readonly SupplementDynamicPrerenderRoute[],
  responseMeta?: SupplementStaticResponseMeta,
): PrerenderPublicArtifact | null {
  if (isAuxiliaryPrerenderPath(prerender.pathname)) return null;
  if (isDynamicPrerenderTemplatePath(model, prerender.pathname, dynamicPrerenderRoutes)) return null;

  const dataRel = nextDataRoutePathname(model, prerender.pathname);
  if (dataRel) return prerenderDataArtifact(model, prerender, dataRel);
  if (isRouteHandlerPrerender(model, prerender)) {
    return routeHandlerPrerenderArtifact(model, prerender, allPublicPathnames, responseMeta);
  }
  return prerenderHtmlArtifact(model, prerender, allPublicPathnames);
}

function prerenderArtifacts(
  model: NextBuildModel,
  dynamicPrerenderRoutes: readonly SupplementDynamicPrerenderRoute[],
  staticMeta: ReadonlyMap<string, SupplementStaticResponseMeta>,
): ArtifactPlanItem[] {
  const items: ArtifactPlanItem[] = [];
  const allPublicPathnames = publicArtifactPathnames(model);
  for (const prerender of model.outputs.prerenders) {
    const artifact = prerenderPublicArtifact(
      model,
      prerender,
      allPublicPathnames,
      dynamicPrerenderRoutes,
      staticMeta.get(prerender.urlPath) ?? staticMeta.get(prerender.pathname),
    );
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

function pagesDynamicFallbackArtifacts(
  model: NextBuildModel,
  supplement: ManifestSupplement,
): ArtifactPlanItem[] {
  const items: ArtifactPlanItem[] = [];
  const allPublicPathnames = uniqueStrings([
    ...publicArtifactPathnames(model),
    ...pagesDynamicFallbackPublicPathnames(model, supplement.dynamicPrerenderRoutes),
  ]);
  for (const route of supplement.dynamicPrerenderRoutes) {
    const shell = pagesDynamicFallbackShell(model, route);
    if (!shell) continue;
    items.push(artifactItem(model, {
      id: `prerender-fallback:${sanitizeId(route.page)}`,
      kind: "prerender",
      ownerRouteId: `prerender-fallback-${sanitizeId(route.page)}`,
      sourceAbsPath: shell.sourceAbsPath,
      packagePath: packageJoin(
        "static",
        publicStoragePackagePath(shell.publicPathname, allPublicPathnames),
      ),
      mountPath: shell.publicPathname,
      contentType: "text/html; charset=utf-8",
      required: true,
      reason: "Pages Router dynamic SSG fallback shell served before invoking the handler",
      precompress: true,
    }));
  }
  return items;
}

function pagesStaticDataArtifacts(model: NextBuildModel): ArtifactPlanItem[] {
  const items: ArtifactPlanItem[] = [];
  for (const output of model.outputs.staticFiles) {
    const pathname = pagesStaticDataPathname(model, output);
    if (pathname) {
      items.push(artifactItem(model, {
        id: `static-data:${sanitizeId(output.urlPath)}`,
        kind: "static",
        ownerRouteId: `pages-static-data-${sanitizeId(output.urlPath)}`,
        generatedContent: pagesStaticDataJson(),
        packagePath: packageJoin("static", pathname),
        mountPath: pathname,
        contentType: "application/json",
        required: true,
        reason: "Pages Router auto-export data JSON generated for client navigation",
        precompress: true,
      }));
    }
    const dynamicMount = pagesStaticDynamicDataMountPath(model, output);
    if (dynamicMount) {
      items.push(artifactItem(model, {
        id: `static-dynamic-data:${sanitizeId(output.urlPath)}`,
        kind: "static",
        ownerRouteId: `pages-static-dynamic-data-${sanitizeId(output.urlPath)}`,
        generatedContent: pagesStaticDataJson(),
        packagePath: packageJoin("static", dynamicMount),
        mountPath: dynamicMount,
        contentType: "application/json",
        required: true,
        reason: "Pages Router auto-static dynamic data JSON generated for client navigation",
        precompress: true,
      }));
    }
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

function pprSegmentPrefetchArtifacts(
  model: NextBuildModel,
  supplement: ManifestSupplement,
): ArtifactPlanItem[] {
  if (supplement.pprSegmentPrefetchRoutes.length === 0) return [];
  const serverDir = path.join(model.distDir, "server");
  const appDir = path.join(serverDir, "app");
  if (!fs.existsSync(appDir)) return [];

  const sourceRegexes = supplement.pprSegmentPrefetchRoutes.map((route) => (
    new RegExp(route.source)
  ));
  const items: ArtifactPlanItem[] = [];
  for (const sourceAbsPath of walkFiles(appDir)) {
    if (!sourceAbsPath.endsWith(".segment.rsc")) continue;
    const rel = path.relative(appDir, sourceAbsPath).split(path.sep).join("/");
    const publicPath = `/${rel}`;
    if (!sourceRegexes.some((regex) => regex.test(publicPath))) continue;
    items.push(artifactItem(model, {
      id: `ppr-segment:${sanitizeId(publicPath)}`,
      kind: "static",
      ownerRouteId: `ppr-segment-${sanitizeId(publicPath)}`,
      sourceAbsPath,
      packagePath: packageJoin("static", rel),
      mountPath: publicPath,
      contentType: "text/x-component",
      required: true,
      reason: "Next PPR segment prefetch artifact served from the filesystem phase",
      precompress: true,
    }));
  }
  return items;
}

function appPrerenderDataArtifacts(
  model: NextBuildModel,
  supplement: ManifestSupplement,
): ArtifactPlanItem[] {
  return supplement.appPrerenderDataRoutes.map((route) => {
    const sourceAbsPath = path.join(model.distDir, "server", "app", route.sourceRel);
    return artifactItem(model, {
      id: `app-prerender-data:${sanitizeId(route.pathname)}`,
      kind: "static",
      ownerRouteId: `app-prerender-data-${sanitizeId(route.pathname)}`,
      sourceAbsPath,
      packagePath: packageJoin("static", route.pathname),
      mountPath: route.pathname,
      contentType: "text/x-component",
      required: true,
      reason: "Next App Router prerender RSC data artifact served from the filesystem phase",
      precompress: true,
    });
  });
}

function routeRuntimeDependencyArtifacts(model: NextBuildModel): ArtifactPlanItem[] {
  const items: ArtifactPlanItem[] = [];
  const seenPackagePaths = new Set<string>();

  const appBundleChunkAlias = (
    sourceAbsPath: string,
  ): { rel: string; packagePath: string; mountPath: string } | null => {
    const serverChunksDir = path.join(model.distDir, "server", "chunks");
    if (!isInsideDir(sourceAbsPath, serverChunksDir)) return null;
    const rel = path.relative(serverChunksDir, sourceAbsPath).split(path.sep).join("/");
    if (!rel || rel.split("/").some((segment) => segment === ".." || segment === "")) {
      return null;
    }
    return {
      rel: packageJoin("chunks", rel),
      packagePath: packageJoin("runtime/chunks", rel),
      mountPath: packageJoin("chunks", rel),
    };
  };

  const pushItem = (item: ArtifactPlanItem) => {
    if (seenPackagePaths.has(item.packagePath)) return;
    seenPackagePaths.add(item.packagePath);
    items.push(item);
  };

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
      if (nodeRel) {
        rel = packageJoin("node_modules", nodeRel);
        packagePath = packageJoin("runtime", rel);
        mountPath = rel;
        artifactReason = `${reason} for server external require`;
      } else if (isInsideDir(sourceAbsPath, model.projectDir)) {
        rel = path.relative(model.projectDir, sourceAbsPath).split(path.sep).join("/");
        packagePath = packageJoin("runtime", rel);
        mountPath = rel;
        artifactReason = `${reason} for project-relative server asset`;
      } else {
        return;
      }
    }

    pushItem(artifactItem(model, {
      id: `route-runtime:${sanitizeId(owner.id)}:${sanitizeId(rel)}`,
      kind: "runtime-file",
      ownerRouteId: sanitizeId(owner.id),
      sourceAbsPath,
      packagePath,
      mountPath,
      required: true,
      reason: artifactReason,
    }));

    const chunkAlias = appBundleChunkAlias(sourceAbsPath);
    if (chunkAlias) {
      pushItem(artifactItem(model, {
        id: `route-runtime:${sanitizeId(owner.id)}:${sanitizeId(chunkAlias.rel)}`,
        kind: "runtime-file",
        ownerRouteId: sanitizeId(owner.id),
        sourceAbsPath,
        packagePath: chunkAlias.packagePath,
        mountPath: chunkAlias.mountPath,
        required: true,
        reason: `${reason} for app bundle runtime chunk URL`,
      }));
    }
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
  return files.flatMap((sourceAbsPath) => {
    const rel = path.relative(model.distDir, sourceAbsPath).split(path.sep).join("/");
    const chunkRel = path.relative(chunkRoot, sourceAbsPath).split(path.sep).join("/");
    return [
      artifactItem(model, {
      id: `server-chunk:${sanitizeId(rel)}`,
      kind: "runtime-file",
      sourceAbsPath,
      packagePath: packageJoin("runtime/.next", rel),
      mountPath: packageJoin(".next", rel),
      required: true,
      reason: "Next server runtime chunk graph",
      }),
      artifactItem(model, {
        id: `server-chunk:${sanitizeId(packageJoin("chunks", chunkRel))}`,
        kind: "runtime-file",
        sourceAbsPath,
        packagePath: packageJoin("runtime/chunks", chunkRel),
        mountPath: packageJoin("chunks", chunkRel),
        required: true,
        reason: "Next server runtime chunk graph for app bundle runtime chunk URL",
      }),
    ];
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
  middleware: BrrrdMiddleware | undefined,
): ArtifactPlanItem[] {
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

function normalizedAssetName(name: string): string | null {
  const normalized = name.split(path.sep).join("/");
  if (
    normalized.length === 0
    || normalized.startsWith("/")
    || normalized.split("/").some((segment) => segment === ".." || segment.length === 0)
  ) {
    return null;
  }
  return normalized;
}

function adapterAssetPackageTarget(
  model: NextBuildModel,
  name: string,
  sourceAbsPath: string,
): { rel: string; packagePath: string; mountPath: string } | null {
  if (!isRegularFile(sourceAbsPath)) return null;

  const normalizedName = normalizedAssetName(name);
  if (normalizedName?.startsWith(".next/")) {
    const rel = normalizedName.slice(".next/".length);
    return {
      rel,
      packagePath: packageJoin("runtime/.next", rel),
      mountPath: packageJoin(".next", rel),
    };
  }

  const nodeRel = nodeModulePackageRel(sourceAbsPath);
  if (nodeRel) {
    return {
      rel: packageJoin("node_modules", nodeRel),
      packagePath: packageJoin("runtime/node_modules", nodeRel),
      mountPath: packageJoin("node_modules", nodeRel),
    };
  }

  if (isInsideDir(sourceAbsPath, model.distDir)) {
    const rel = path.relative(model.distDir, sourceAbsPath).split(path.sep).join("/");
    return {
      rel,
      packagePath: packageJoin("runtime/.next", rel),
      mountPath: packageJoin(".next", rel),
    };
  }

  if (!normalizedName) return null;
  return {
    rel: normalizedName,
    packagePath: packageJoin("runtime", normalizedName),
    mountPath: normalizedName,
  };
}

function middlewareAdapterAssetArtifacts(
  model: NextBuildModel,
  middleware: BrrrdMiddleware | undefined,
): ArtifactPlanItem[] {
  const output = model.outputs.middleware;
  if (!output) return [];

  const evaluated = new Set(middleware?.files ?? []);
  const seenPackagePaths = new Set<string>();
  const items: ArtifactPlanItem[] = [];
  for (const [name, sourceAbsPath] of Object.entries(output.assets)) {
    const target = adapterAssetPackageTarget(model, name, sourceAbsPath);
    if (!target) continue;
    const distRel = isInsideDir(sourceAbsPath, model.distDir)
      ? path.relative(model.distDir, sourceAbsPath).split(path.sep).join("/")
      : null;
    if (distRel && evaluated.has(distRel)) continue;
    if (seenPackagePaths.has(target.packagePath)) continue;
    seenPackagePaths.add(target.packagePath);
    items.push(artifactItem(model, {
      id: `middleware-asset:${sanitizeId(target.mountPath)}`,
      kind: "runtime-file",
      sourceAbsPath,
      packagePath: target.packagePath,
      mountPath: target.mountPath,
      required: true,
      reason: "Next Adapter API proxy/middleware runtime asset",
    }));
  }
  return items;
}

function nodeMiddlewareNextServerRuntimeArtifacts(
  model: NextBuildModel,
  middleware: BrrrdMiddleware | undefined,
): ArtifactPlanItem[] {
  if (middleware?.moduleFormat !== "node") return [];

  const projectRequire = createRequire(path.join(model.projectDir, "package.json"));
  let nextServerDir: string;
  try {
    nextServerDir = path.dirname(
      projectRequire.resolve("next/dist/compiled/next-server/pages.runtime.prod.js"),
    );
  } catch {
    return [];
  }

  const files = fs.existsSync(nextServerDir)
    ? fs.readdirSync(nextServerDir, { withFileTypes: true })
    : [];

  const runtimeFiles = files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".runtime.prod.js"))
    .map((entry) => path.join(nextServerDir, entry.name));

  const runtimeItems = runtimeFiles
    .map((sourceAbsPath) => {
      const nodeRel = nodeModulePackageRel(sourceAbsPath);
      if (!nodeRel) return null;
      return artifactItem(model, {
        id: `middleware-next-server-runtime:${sanitizeId(nodeRel)}`,
        kind: "runtime-file",
        sourceAbsPath,
        packagePath: packageJoin("runtime/node_modules", nodeRel),
        mountPath: packageJoin("node_modules", nodeRel),
        required: true,
        reason: "Next node proxy/middleware compiled next-server runtime dependency",
      });
    })
    .filter((item): item is ArtifactPlanItem => item !== null);

  return [
    ...runtimeItems,
    ...nodeMiddlewareNextSupportDependencyArtifacts(model, projectRequire, runtimeFiles),
  ];
}

function commonJsRequireSpecifiers(sourceAbsPath: string): string[] {
  let source: string;
  try {
    source = fs.readFileSync(sourceAbsPath, "utf8");
  } catch {
    return [];
  }

  const out: string[] = [];
  const pattern = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) out.push(match[1]);
  return uniqueStrings(out);
}

function resolveCommonJsFileFrom(base: string): string | null {
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}.json`,
    path.join(base, "index.js"),
  ];
  const found = candidates.find((candidate) => isRegularFile(candidate));
  if (found) return found;

  const packageJson = path.join(base, "package.json");
  const pkg = readJsonIfExists(packageJson);
  if (typeof pkg?.main !== "string" || pkg.main.length === 0) return null;
  return resolveCommonJsFileFrom(path.resolve(base, pkg.main));
}

function nextCompiledPackageRoot(
  projectRequire: NodeRequire,
  specifier: string,
): string | null {
  if (!specifier.startsWith("next/dist/compiled/")) return null;

  let nextRoot: string;
  try {
    nextRoot = path.dirname(projectRequire.resolve("next/package.json"));
  } catch {
    return null;
  }

  const rel = specifier.slice("next/dist/compiled/".length);
  const parts = rel.split("/");
  const packageName = parts[0]?.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0];
  if (!packageName) return null;

  const packageRoot = path.join(nextRoot, "dist", "compiled", packageName);
  if (fs.existsSync(packageRoot)) return packageRoot;

  try {
    const resolved = projectRequire.resolve(specifier);
    return isRegularFile(resolved) ? path.dirname(resolved) : resolved;
  } catch {
    return null;
  }
}

function nextPackageFileForSpecifier(
  projectRequire: NodeRequire,
  fromFile: string,
  specifier: string,
): string | null {
  if (specifier.startsWith(".")) {
    return resolveCommonJsFileFrom(path.resolve(path.dirname(fromFile), specifier));
  }
  if (!specifier.startsWith("next/")) return null;
  try {
    const resolved = projectRequire.resolve(specifier);
    return isRegularFile(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function nodeMiddlewareNextSupportDependencyArtifacts(
  model: NextBuildModel,
  projectRequire: NodeRequire,
  roots: string[],
): ArtifactPlanItem[] {
  const seenRoots = new Set<string>();
  const seenPackagePaths = new Set<string>();
  const scannedFiles = new Set<string>();
  const queue = [...roots];
  const items: ArtifactPlanItem[] = [];

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (scannedFiles.has(current) || !isRegularFile(current)) continue;
    scannedFiles.add(current);

    for (const specifier of commonJsRequireSpecifiers(current)) {
      const packageRoot = nextCompiledPackageRoot(projectRequire, specifier);
      const dependencyFiles = packageRoot
        ? walkFiles(packageRoot)
        : (() => {
            const file = nextPackageFileForSpecifier(projectRequire, current, specifier);
            return file ? [file] : [];
          })();

      if (packageRoot) {
        if (seenRoots.has(packageRoot)) continue;
        seenRoots.add(packageRoot);
      }

      for (const sourceAbsPath of dependencyFiles) {
        queue.push(sourceAbsPath);
        const nodeRel = nodeModulePackageRel(sourceAbsPath);
        if (!nodeRel) continue;
        const packagePath = packageJoin("runtime/node_modules", nodeRel);
        if (seenPackagePaths.has(packagePath)) continue;
        seenPackagePaths.add(packagePath);
        items.push(artifactItem(model, {
          id: `middleware-next-support:${sanitizeId(nodeRel)}`,
          kind: "runtime-file",
          sourceAbsPath,
          packagePath,
          mountPath: packageJoin("node_modules", nodeRel),
          required: true,
          reason: packageRoot
            ? "Next node proxy/middleware compiled package dependency"
            : "Next node proxy/middleware server runtime dependency",
        }));
      }
    }
  }

  return items;
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
  options: { hasAppBundle: boolean; middleware?: BrrrdMiddleware },
): ArtifactPlan {
  const allPublicPathnames = publicArtifactPathnames(model);
  const staticMeta = staticResponseMetaByPathname(supplement.staticResponseMeta);
  return {
    items: dedupePlanItems([
      ...(options.hasAppBundle ? [appBundleArtifact(model, outDir)] : []),
      ...model.outputs.staticFiles
        .filter((output) => !isPagesRscFallbackOutput(output))
        .map((output) => (
          staticArtifact(
            model,
            output,
            allPublicPathnames,
            staticMeta.get(output.urlPath) ?? staticMeta.get(output.pathname),
          )
        )),
      ...pagesStaticDataArtifacts(model),
      ...pagesDynamicFallbackArtifacts(model, supplement),
      ...prerenderArtifacts(model, supplement.dynamicPrerenderRoutes, staticMeta),
      ...appPrerenderDataArtifacts(model, supplement),
      ...pprSegmentPrefetchArtifacts(model, supplement),
      ...runtimeManifestArtifacts(model),
      ...clientReferenceArtifacts(model),
      ...appPrerenderRuntimeArtifacts(model),
      ...routeRuntimeDependencyArtifacts(model),
      ...serverChunkGraphArtifacts(model),
      ...cacheHandlerArtifacts(model),
      ...middlewareAdapterAssetArtifacts(model, options.middleware),
      ...middlewareArtifacts(model, options.middleware),
      ...nodeMiddlewareNextServerRuntimeArtifacts(model, options.middleware),
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
    } else if (item.generatedContent !== undefined) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, item.generatedContent);
    } else if (item.required && !fs.existsSync(dest)) {
      throw new Error(`${item.reason} does not exist: ${dest}`);
    }

    if (item.precompress && (item.sourceAbsPath || item.generatedContent !== undefined)) {
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
