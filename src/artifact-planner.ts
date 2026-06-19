import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as zlib from "node:zlib";

import type { ManifestSupplement } from "./manifest-supplement.js";
import type { NextBuildModel, NormalizedOutput } from "./model.js";
import type { BrrrdArtifact } from "./types.js";
import {
  listPrerenderPathnames,
  prerenderStaticFile,
  sanitizeId,
} from "./routing.js";

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
  compressedCount: number;
};

function packageJoin(...parts: string[]): string {
  return path.posix.join(
    ...parts.map((part) => part.split(path.sep).join("/").replace(/^\/+/, "")),
  );
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

function staticArtifact(model: NextBuildModel, output: NormalizedOutput): ArtifactPlanItem {
  if (!output.filePath) throw new Error(`missing filePath for static file ${output.pathname}`);
  const packagePath = packageJoin("static", output.pathname);
  return artifactItem(model, {
    id: `static:${sanitizeId(output.pathname)}`,
    kind: output.kind === "public" ? "public" : "static",
    ownerRouteId: `static-${sanitizeId(output.pathname)}`,
    sourceAbsPath: output.filePath,
    packagePath,
    mountPath: output.pathname,
    immutable: !!output.immutableHash,
    required: true,
    reason: output.kind === "public"
      ? "project public/ file served by Next static layer"
      : "Next Adapter API staticFiles output",
    precompress: true,
  });
}

function prerenderArtifacts(model: NextBuildModel): ArtifactPlanItem[] {
  const items: ArtifactPlanItem[] = [];
  const prerenderPaths = listPrerenderPathnames(model.outputs.prerenders);
  for (const prerender of model.outputs.prerenders) {
    if (
      prerender.pathname.includes(".rsc")
      || prerender.pathname.includes(".segment")
      || prerender.pathname.includes("[")
    ) continue;

    const htmlName = prerender.pathname === "/"
      ? "index.html"
      : prerender.pathname.replace(/^\//, "") + ".html";
    const htmlPath = prerender.filePath ?? path.join(model.distDir, "server/app", htmlName);
    const destName = prerender.pathname === "/"
      ? "index"
      : prerenderStaticFile(prerender.pathname, prerenderPaths).replace(/^\//, "");
    items.push(artifactItem(model, {
      id: `prerender:${sanitizeId(prerender.pathname)}`,
      kind: "prerender",
      ownerRouteId: `prerender-${sanitizeId(prerender.pathname)}`,
      sourceAbsPath: htmlPath,
      packagePath: packageJoin("static", destName),
      mountPath: prerender.pathname,
      required: true,
      reason: "static prerender HTML served without invoking the handler",
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
    middleware.runtimeRel,
    middleware.entryRel,
    ...middleware.wasm.map((file) => file.filePath),
    ...middleware.assets.map((file) => file.filePath),
  ];
  return refs.map((rel) => artifactItem(model, {
    id: `middleware:${rel}`,
    kind: "middleware",
    sourceAbsPath: path.join(model.distDir, rel),
    packagePath: packageJoin("runtime", rel),
    mountPath: rel,
    required: true,
    reason: "Next proxy/middleware webpack chunk or supporting asset",
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

export function createArtifactPlan(
  model: NextBuildModel,
  supplement: ManifestSupplement,
  outDir: string,
  options: { hasAppBundle: boolean },
): ArtifactPlan {
  return {
    items: [
      ...(options.hasAppBundle ? [appBundleArtifact(model, outDir)] : []),
      ...model.outputs.staticFiles.map((output) => staticArtifact(model, output)),
      ...prerenderArtifacts(model),
      ...runtimeManifestArtifacts(model),
      ...clientReferenceArtifacts(model),
      ...appPrerenderRuntimeArtifacts(model),
      ...cacheHandlerArtifacts(model),
      ...middlewareArtifacts(model, supplement),
    ],
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
