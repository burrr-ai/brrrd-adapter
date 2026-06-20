import * as fs from "node:fs";
import * as path from "node:path";

import type { ManifestSupplement } from "./manifest-supplement.js";
import type { NextBuildModel, NormalizedOutput } from "./model.js";
import { requestOutputs } from "./model.js";
import { sanitizeId } from "./routing.js";
import type { BrrrdEdgeFunction, BrrrdMiddlewareFile } from "./types.js";

function isEdgeRuntime(runtime: string | undefined): boolean {
  return runtime === "edge" || runtime === "experimental-edge";
}

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

function nameFromEntryKey(entryKey: string, fallback: string): string {
  if (entryKey.startsWith("middleware_")) return entryKey.slice("middleware_".length);
  return fallback;
}

function handlerExport(value: string | undefined): "default" | "handler" {
  return value === "handler" ? "handler" : "default";
}

function middlewareFileRefs(
  distDir: string,
  assets: Record<string, string> | undefined,
): BrrrdMiddlewareFile[] {
  const out: BrrrdMiddlewareFile[] = [];
  for (const [name, absPath] of Object.entries(assets ?? {})) {
    const filePath = relativeToDist(distDir, absPath);
    if (!filePath) continue;
    out.push({ name, filePath });
  }
  return out;
}

function edgeFunctionFromAdapterOutput(
  model: NextBuildModel,
  output: NormalizedOutput,
): BrrrdEdgeFunction | null {
  if (!isEdgeRuntime(output.runtime) || !output.edgeRuntime) return null;

  const entry = relativeToDist(model.distDir, output.edgeRuntime.modulePath)
    ?? (output.filePath ? relativeToDist(model.distDir, output.filePath) : null);
  if (!entry) return null;

  const files = uniqueStrings([
    ...Object.values(output.assets)
      .map((asset) => relativeToDist(model.distDir, asset))
      .filter((asset): asset is string => !!asset),
    entry,
  ]);
  if (files.length === 0 || files.some((file) => !fs.existsSync(path.join(model.distDir, file)))) {
    return null;
  }

  const id = sanitizeId(output.id);
  return {
    id,
    files,
    runtime: runtimeFile(files, entry),
    entry,
    entryKey: output.edgeRuntime.entryKey,
    name: nameFromEntryKey(output.edgeRuntime.entryKey, output.id),
    page: output.sourcePage || output.pathname,
    handlerExport: handlerExport(output.edgeRuntime.handlerExport),
    wasm: middlewareFileRefs(model.distDir, output.wasmAssets),
    assets: [],
    env: Object.fromEntries(
      Object.entries(output.config.env ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  };
}

/**
 * Build the concrete Edge function registry used by the brrrd manifest.
 *
 * Adapter API `edgeRuntime` is the primary contract: it carries the canonical
 * registry key and entry module for each Edge output. middleware-manifest is
 * still useful as a fallback and for older shapes, but it is not the authority
 * when Adapter API metadata is present.
 */
export function compileEdgeFunctions(
  model: NextBuildModel,
  supplement: Pick<ManifestSupplement, "edgeFunctions">,
): Map<string, BrrrdEdgeFunction> {
  const out = new Map<string, BrrrdEdgeFunction>(supplement.edgeFunctions);
  for (const output of requestOutputs(model)) {
    const fn = edgeFunctionFromAdapterOutput(model, output);
    if (!fn) continue;
    out.set(fn.id, fn);
  }
  return out;
}

