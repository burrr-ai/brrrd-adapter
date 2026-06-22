import * as fs from "node:fs";
import * as path from "node:path";

import type { ManifestSupplement } from "./manifest-supplement.js";
import type { NextBuildModel, NormalizedOutput } from "./model.js";
import type {
  BrrrdMiddleware,
  BrrrdMiddlewareCondition,
  BrrrdMiddlewareFile,
} from "./types.js";

const JS_CHUNK_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const ROUTE_FILE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function relativeToDist(distDir: string, filePath: string): string | null {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(distDir, filePath);
  const rel = path.relative(distDir, abs);
  if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function runtimeFile(files: string[], entry: string): string {
  return files.find((file) => file !== entry) ?? entry;
}

function normalizeConditions(value: unknown): BrrrdMiddlewareCondition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: BrrrdMiddlewareCondition[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const type = item.type;
    const key = item.key;
    if (type === "header" || type === "cookie" || type === "query" || type === "host") {
      if (type !== "host" && (typeof key !== "string" || key.length === 0)) continue;
      const cond: BrrrdMiddlewareCondition = { type };
      if (typeof key === "string" && key.length > 0) cond.key = key;
      if (typeof item.value === "string") cond.value = item.value;
      out.push(cond);
    }
  }
  return out.length > 0 ? out : undefined;
}

function middlewareFileRefs(
  distDir: string,
  assets: Record<string, string> | undefined,
  exclude: Set<string> = new Set(),
): BrrrdMiddlewareFile[] {
  const out: BrrrdMiddlewareFile[] = [];
  for (const [name, absPath] of Object.entries(assets ?? {})) {
    const filePath = relativeToDist(distDir, absPath);
    if (!filePath) continue;
    if (exclude.has(filePath)) continue;
    out.push({ name, filePath });
  }
  return out;
}

function assetChunkFiles(model: NextBuildModel, output: NormalizedOutput): string[] {
  return Object.values(output.assets)
    .map((asset) => relativeToDist(model.distDir, asset))
    .filter((asset): asset is string => (
      !!asset && JS_CHUNK_EXTENSIONS.has(path.extname(asset).toLowerCase())
    ));
}

function evaluatedFiles(
  model: NextBuildModel,
  output: NormalizedOutput,
  entry: string,
): string[] {
  const chunks = assetChunkFiles(model, output).filter((file) => file !== entry);
  if (output.runtime === "nodejs") {
    const runtime = chunks.find((file) => path.posix.basename(file) === "webpack-runtime.js");
    return uniqueStrings([...(runtime ? [runtime] : []), entry]);
  }
  return uniqueStrings([...chunks, entry]);
}

function matcherSpecs(output: NormalizedOutput): BrrrdMiddleware["matchers"] {
  const matchers = output.config.matchers;
  if (!Array.isArray(matchers)) return [];
  return matchers
    .filter((raw): raw is Record<string, unknown> => (
      !!raw && typeof raw === "object" && typeof raw.sourceRegex === "string"
    ))
    .map((raw) => {
      const has = normalizeConditions(raw.has);
      const missing = normalizeConditions(raw.missing);
      return {
        regexp: raw.sourceRegex as string,
        originalSource: typeof raw.source === "string" ? raw.source : "",
        ...(has ? { has } : {}),
        ...(missing ? { missing } : {}),
      };
    });
}

function stringEnv(output: NormalizedOutput): Record<string, string> {
  const env = output.config.env;
  if (!env || typeof env !== "object") return {};
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string"
    )),
  );
}

function middlewareEntryName(output: NormalizedOutput): string {
  const entryKey = output.edgeRuntime?.entryKey;
  if (entryKey?.startsWith("middleware_")) return entryKey.slice("middleware_".length);
  return "middleware";
}

function hasConventionFile(projectDir: string, convention: "proxy" | "middleware"): boolean {
  for (const root of [projectDir, path.join(projectDir, "src")]) {
    for (const ext of ROUTE_FILE_EXTENSIONS) {
      if (fs.existsSync(path.join(root, `${convention}${ext}`))) return true;
    }
  }
  return false;
}

function sourcePageForMiddleware(model: NextBuildModel, output: NormalizedOutput): string {
  const source = output.sourcePage;
  if (typeof source === "string" && source.startsWith("/")) return source;
  if (hasConventionFile(model.projectDir, "proxy")) return "/proxy";
  if (hasConventionFile(model.projectDir, "middleware")) return "/middleware";
  return "/middleware";
}

function assertMiddlewareFilesExist(model: NextBuildModel, files: string[]): void {
  for (const rel of files) {
    if (!fs.existsSync(path.join(model.distDir, rel))) {
      throw new Error(`middleware Adapter API output referenced file missing: ${rel}`);
    }
  }
}

function middlewareFromAdapterOutput(
  model: NextBuildModel,
  output: NormalizedOutput,
): BrrrdMiddleware {
  const entry = output.filePath ? relativeToDist(model.distDir, output.filePath) : null;
  if (!entry) {
    throw new Error("middleware Adapter API output is missing a dist-relative filePath");
  }

  const files = evaluatedFiles(model, output, entry);
  assertMiddlewareFilesExist(model, files);
  const evaluated = new Set(files);

  return {
    moduleFormat: output.runtime === "nodejs" ? "node" : "edge",
    files,
    runtime: runtimeFile(files, entry),
    entry,
    name: middlewareEntryName(output),
    page: sourcePageForMiddleware(model, output),
    matchers: matcherSpecs(output),
    wasm: middlewareFileRefs(model.distDir, output.wasmAssets),
    assets: middlewareFileRefs(model.distDir, output.assets, evaluated),
    env: stringEnv(output),
  };
}

function middlewareFromSupplement(
  supplement: ManifestSupplement,
): BrrrdMiddleware | undefined {
  const middleware = supplement.middleware;
  if (!middleware) return undefined;
  return {
    moduleFormat: "edge",
    files: middleware.files,
    runtime: middleware.runtimeRel,
    entry: middleware.entryRel,
    name: middleware.name,
    page: middleware.page,
    matchers: middleware.matchers,
    wasm: middleware.wasm,
    assets: middleware.assets,
    env: middleware.env,
  };
}

export function compileMiddleware(
  model: NextBuildModel,
  supplement: ManifestSupplement,
): BrrrdMiddleware | undefined {
  if (model.outputs.middleware) {
    return middlewareFromAdapterOutput(model, model.outputs.middleware);
  }
  return middlewareFromSupplement(supplement);
}
