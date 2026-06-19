import * as fs from "node:fs";
import * as path from "node:path";

import type {
  BrrrdMiddlewareCondition,
  BrrrdMiddlewareFile,
} from "./types.js";

export type MiddlewareMeta = {
  runtimeRel: string;
  entryRel: string;
  name: string;
  page: string;
  matchers: Array<{
    regexp: string;
    originalSource: string;
    has?: BrrrdMiddlewareCondition[];
    missing?: BrrrdMiddlewareCondition[];
  }>;
  wasm: BrrrdMiddlewareFile[];
  assets: BrrrdMiddlewareFile[];
  env: Record<string, string>;
};

export type ManifestSupplement = {
  middleware: MiddlewareMeta | null;
  pprPages: string[];
  redirects: SupplementRedirect[];
};

export type SupplementRedirect = {
  regex: string;
  source: string;
  destination: string;
  statusCode: number;
};

function readJsonIfExists(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
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

function normalizeMiddlewareFiles(value: unknown): BrrrdMiddlewareFile[] {
  if (!Array.isArray(value)) return [];
  const out: BrrrdMiddlewareFile[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const filePath = item.filePath ?? item.file;
    if (typeof filePath !== "string" || filePath.length === 0) continue;
    out.push({
      filePath,
      ...(typeof item.name === "string" ? { name: item.name } : {}),
    });
  }
  return out;
}

/**
 * middleware-manifest.json supplements the Adapter API with concrete webpack
 * chunk files. These chunks are raw-copied; they are not source-of-truth routing
 * rules for pages/app routes.
 */
export function extractMiddlewareMeta(distDir: string): MiddlewareMeta | null {
  const manifestPath = path.join(distDir, "server", "middleware-manifest.json");
  const raw = readJsonIfExists(manifestPath);
  if (!raw) return null;
  const middlewareMap = raw?.middleware ?? {};
  const mountKeys = Object.keys(middlewareMap);
  if (mountKeys.length > 1) {
    throw new Error(
      `multiple middleware entries are not supported by brrrd adapter: ${mountKeys.join(", ")}`,
    );
  }
  const mountKey = mountKeys[0];
  if (!mountKey) return null;
  const mw = middlewareMap[mountKey];
  if (!mw) return null;
  const filesArr: string[] = Array.isArray(mw.files) ? mw.files : [];
  const runtimeRel = filesArr.find((f) => f.includes("edge-runtime-webpack"))
    ?? "server/edge-runtime-webpack.js";
  const entryRel = typeof mw.entrypoint === "string" && mw.entrypoint.length > 0
    ? mw.entrypoint
    : filesArr.find((f) => f.endsWith("middleware.js") || f.endsWith("proxy.js"))
    ?? "server/middleware.js";
  if (!fs.existsSync(path.join(distDir, runtimeRel))) {
    throw new Error(`middleware runtime file missing: ${runtimeRel}`);
  }
  if (!fs.existsSync(path.join(distDir, entryRel))) {
    throw new Error(`middleware entry file missing: ${entryRel}`);
  }

  const matchersArr: Array<{
    regexp?: string;
    originalSource?: string;
    has?: unknown;
    missing?: unknown;
  }> = Array.isArray(mw.matchers) ? mw.matchers : [];
  const matchers = matchersArr
    .filter((m) => typeof m.regexp === "string")
    .map((m) => {
      const has = normalizeConditions(m.has);
      const missing = normalizeConditions(m.missing);
      return {
        regexp: m.regexp as string,
        originalSource: typeof m.originalSource === "string" ? m.originalSource : "",
        ...(has ? { has } : {}),
        ...(missing ? { missing } : {}),
      };
    });
  const envIn = mw.env && typeof mw.env === "object" ? mw.env : {};
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envIn)) {
    if (typeof v === "string") env[k] = v;
  }
  return {
    runtimeRel,
    entryRel,
    name: typeof mw.name === "string" ? mw.name : "middleware",
    page: typeof mw.page === "string" ? mw.page : "/middleware",
    matchers,
    wasm: normalizeMiddlewareFiles(mw.wasm),
    assets: normalizeMiddlewareFiles(mw.assets),
    env,
  };
}

export function extractPprPages(distDir: string): string[] {
  const raw = readJsonIfExists(path.join(distDir, "prerender-manifest.json"));
  if (!raw) return [];
  const routes = raw?.routes ?? {};
  const pages: string[] = [];
  for (const [route, meta] of Object.entries(routes)) {
    const item = meta as Record<string, unknown>;
    if (item?.experimentalPPR === true || item?.renderingMode === "PARTIALLY_STATIC") {
      pages.push(route);
    }
  }
  return pages;
}

export function extractRedirectSupplement(distDir: string): SupplementRedirect[] {
  const raw = readJsonIfExists(path.join(distDir, "routes-manifest.json"));
  if (!raw || !Array.isArray(raw.redirects)) return [];
  const redirects: SupplementRedirect[] = [];
  for (const item of raw.redirects) {
    if (!item || typeof item !== "object") continue;
    if (item.internal === true) continue;
    if (
      typeof item.regex !== "string"
      || typeof item.destination !== "string"
    ) continue;
    redirects.push({
      regex: item.regex,
      source: typeof item.source === "string" ? item.source : "",
      destination: item.destination,
      statusCode: typeof item.statusCode === "number"
        ? item.statusCode
        : (item.permanent ? 308 : 307),
    });
  }
  return redirects;
}

export function createManifestSupplement(distDir: string): ManifestSupplement {
  return {
    middleware: extractMiddlewareMeta(distDir),
    pprPages: extractPprPages(distDir),
    redirects: extractRedirectSupplement(distDir),
  };
}
