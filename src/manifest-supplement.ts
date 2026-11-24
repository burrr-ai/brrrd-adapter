import * as fs from "node:fs";
import * as path from "node:path";

import type {
  BrrrdFallbackRouteParam,
  BrrrdHeaderPair,
  BrrrdMiddlewareCondition,
  BrrrdPreviewConfig,
} from "./types.js";
import type { NormalizedOutput } from "./model.js";

export type ManifestSupplement = {
  preview: BrrrdPreviewConfig | null;
  pprPages: string[];
  appPrerenderDataRoutes: SupplementAppPrerenderDataRoute[];
  pprSegmentPrefetchRoutes: SupplementPrefetchSegmentDataRoute[];
  prerenderResponseMeta: SupplementPrerenderResponseMeta[];
  staticResponseMeta: SupplementStaticResponseMeta[];
  dynamicPrerenderRoutes: SupplementDynamicPrerenderRoute[];
  redirects: SupplementRedirect[];
  rewrites: SupplementRewritePhases;
  staticRoutes: SupplementStaticRoute[];
};

export type SupplementRedirect = {
  regex: string;
  source: string;
  destination: string;
  statusCode: number;
  locale?: false;
};

export type SupplementRewrite = {
  regex: string;
  source: string;
  destination: string;
  locale?: false;
};

export type SupplementRewritePhases = {
  beforeFiles: SupplementRewrite[];
  afterFiles: SupplementRewrite[];
  fallback: SupplementRewrite[];
};

export type SupplementStaticRoute = {
  page: string;
  regex: string;
};

export type SupplementDynamicPrerenderRoute = {
  page: string;
  routeRegex: string;
  dataRoute?: string;
  dataRouteRegex?: string;
  fallback: false | null | string;
  bypass: BrrrdMiddlewareCondition[];
  fallbackRouteParams?: BrrrdFallbackRouteParam[];
};

export type SupplementPrefetchSegmentDataRoute = {
  page: string;
  source: string;
  destination: string;
};

export type SupplementAppPrerenderDataRoute = {
  pathname: string;
  sourceRel: string;
  filePath?: string;
};

export type SupplementPrerenderResponseMeta = {
  pathname: string;
  status?: number;
  headers: BrrrdHeaderPair[];
  prerenderBypass?: BrrrdMiddlewareCondition[];
};

export type SupplementStaticResponseMeta = {
  pathname: string;
  sourceRel: string;
  status?: number;
  headers: BrrrdHeaderPair[];
};

function extractPreviewConfig(distDir: string): BrrrdPreviewConfig | null {
  const raw = readJsonIfExists(path.join(distDir, "prerender-manifest.json"));
  const preview = raw?.preview;
  if (!preview || typeof preview !== "object") return null;
  const item = preview as Record<string, unknown>;
  if (typeof item.previewModeId !== "string" || item.previewModeId.length === 0) {
    return null;
  }
  return {
    previewModeId: item.previewModeId,
    ...(typeof item.previewModeSigningKey === "string"
      ? { previewModeSigningKey: item.previewModeSigningKey }
      : {}),
    ...(typeof item.previewModeEncryptionKey === "string"
      ? { previewModeEncryptionKey: item.previewModeEncryptionKey }
      : {}),
  };
}

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

function normalizeFallbackRouteParams(value: unknown): BrrrdFallbackRouteParam[] {
  if (!Array.isArray(value)) return [];
  const out: BrrrdFallbackRouteParam[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.paramName !== "string"
      || item.paramName.length === 0
      || typeof item.paramType !== "string"
      || item.paramType.length === 0
    ) {
      continue;
    }
    out.push({
      paramName: item.paramName,
      paramType: item.paramType,
    });
  }
  return out;
}

function normalizeResponseHeaders(value: unknown): BrrrdHeaderPair[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    const out: BrrrdHeaderPair[] = [];
    for (const raw of value) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const key = item.key ?? item.name;
      const headerValue = item.value;
      if (typeof key === "string" && typeof headerValue === "string") {
        out.push({ key, value: headerValue });
      }
    }
    return out;
  }
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => (
      entry[0].length > 0 && typeof entry[1] === "string"
    ))
    .map(([key, headerValue]) => ({ key, value: headerValue }));
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

export function extractDynamicPrerenderRoutes(distDir: string): SupplementDynamicPrerenderRoute[] {
  const raw = readJsonIfExists(path.join(distDir, "prerender-manifest.json"));
  const dynamicRoutes = raw?.dynamicRoutes;
  if (!dynamicRoutes || typeof dynamicRoutes !== "object") return [];

  const out: SupplementDynamicPrerenderRoute[] = [];
  for (const [page, meta] of Object.entries(dynamicRoutes)) {
    if (!page || !meta || typeof meta !== "object") continue;
    const item = meta as Record<string, unknown>;
    const routeRegex = item.routeRegex;
    if (typeof routeRegex !== "string" || routeRegex.length === 0) continue;
    const fallback = item.fallback;
    if (
      fallback !== false
      && fallback !== null
      && typeof fallback !== "string"
    ) continue;
    const fallbackRouteParams = normalizeFallbackRouteParams(item.fallbackRouteParams);
    out.push({
      page,
      routeRegex,
      ...(typeof item.dataRoute === "string" && item.dataRoute.length > 0
        ? { dataRoute: item.dataRoute }
        : {}),
      ...(typeof item.dataRouteRegex === "string" && item.dataRouteRegex.length > 0
        ? { dataRouteRegex: item.dataRouteRegex }
        : {}),
      fallback,
      bypass: normalizeConditions(item.experimentalBypassFor) ?? [],
      ...(fallbackRouteParams.length > 0 ? { fallbackRouteParams } : {}),
    });
  }
  return out.sort((a, b) => a.page.localeCompare(b.page));
}

export function extractAppPrerenderDataRoutes(
  distDir: string,
  prerenders: readonly NormalizedOutput[] = [],
): SupplementAppPrerenderDataRoute[] {
  // Route-cache paths contain owner namespaces, not public URL paths.
  // Prefer the Adapter API and retain disk discovery for older builds.
  if (prerenders.length > 0) {
    return prerenders
      .filter((output) => output.pathname.endsWith(".rsc") && output.filePath)
      .map((output) => ({
        pathname: output.pathname,
        filePath: output.filePath,
        sourceRel: output.pathname.slice(1),
      }))
      .sort((a, b) => a.pathname.localeCompare(b.pathname));
  }
  const appDir = path.join(distDir, "server", "app");
  return walkFiles(appDir)
    .filter((filePath) => filePath.endsWith(".rsc"))
    .map((filePath) => {
      const sourceRel = path.relative(appDir, filePath).split(path.sep).join("/");
      return {
        pathname: `/${sourceRel}`,
        sourceRel,
      };
    })
    .sort((a, b) => a.sourceRel.localeCompare(b.sourceRel));
}

function appPrerenderMetaPathname(sourceRel: string): string {
  const withoutExt = sourceRel.slice(0, -".meta".length);
  if (withoutExt === "index") return "/";
  return `/${withoutExt}`;
}

function appStaticMetaPathname(sourceRel: string): string {
  const withoutExt = sourceRel.slice(0, -".meta".length);
  if (withoutExt === "index") return "/";
  return `/${withoutExt}`;
}

function appStaticBodySourceRel(pathname: string): string | null {
  if (!pathname.startsWith("/") || pathname.includes("//")) return null;
  const rel = pathname === "/" ? "index" : pathname.slice(1);
  if (rel.split("/").some((segment) => segment.length === 0 || segment === "..")) {
    return null;
  }
  return `${rel}.body`;
}

function responseMetaFromJson(
  raw: unknown,
): { status?: number; headers: BrrrdHeaderPair[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const status = typeof item.status === "number" && Number.isInteger(item.status)
    ? item.status
    : undefined;
  const headers = normalizeResponseHeaders(item.headers);
  if (status === undefined && headers.length === 0) return null;
  return {
    ...(status !== undefined ? { status } : {}),
    headers,
  };
}

function mergeStaticResponseMeta(
  byPathname: Map<string, SupplementStaticResponseMeta>,
  next: SupplementStaticResponseMeta,
): void {
  const existing = byPathname.get(next.pathname);
  if (!existing) {
    byPathname.set(next.pathname, next);
    return;
  }
  const headersByKey = new Map<string, BrrrdHeaderPair>();
  for (const header of existing.headers) headersByKey.set(header.key.toLowerCase(), header);
  for (const header of next.headers) headersByKey.set(header.key.toLowerCase(), header);
  byPathname.set(next.pathname, {
    pathname: next.pathname,
    sourceRel: next.sourceRel,
    ...(next.status !== undefined
      ? { status: next.status }
      : existing.status !== undefined
        ? { status: existing.status }
        : {}),
    headers: Array.from(headersByKey.values()),
  });
}

export function extractAppPrerenderResponseMeta(distDir: string): SupplementPrerenderResponseMeta[] {
  const appDir = path.join(distDir, "server", "app");
  const byPathname = new Map<string, SupplementPrerenderResponseMeta>();
  for (const filePath of walkFiles(appDir).filter((file) => file.endsWith(".meta"))) {
    const meta = responseMetaFromJson(readJsonIfExists(filePath));
    if (!meta) continue;
    const sourceRel = path.relative(appDir, filePath).split(path.sep).join("/");
    byPathname.set(appPrerenderMetaPathname(sourceRel), {
      pathname: appPrerenderMetaPathname(sourceRel),
      ...meta,
    });
  }

  const prerenderManifest = readJsonIfExists(path.join(distDir, "prerender-manifest.json"));
  const prerenderRoutes = prerenderManifest?.routes;
  if (prerenderRoutes && typeof prerenderRoutes === "object") {
    for (const [pathname, raw] of Object.entries(prerenderRoutes)) {
      if (!pathname.startsWith("/") || !raw || typeof raw !== "object") continue;
      const bypass = normalizeConditions(
        (raw as Record<string, unknown>).experimentalBypassFor,
      );
      if (!bypass || bypass.length === 0) continue;
      const existing = byPathname.get(pathname);
      byPathname.set(pathname, {
        pathname,
        ...(existing?.status !== undefined ? { status: existing.status } : {}),
        headers: existing?.headers ?? [],
        prerenderBypass: bypass,
      });
    }
  }

  return Array.from(byPathname.values()).sort((a, b) => a.pathname.localeCompare(b.pathname));
}

export function extractAppStaticResponseMeta(distDir: string): SupplementStaticResponseMeta[] {
  const appDir = path.join(distDir, "server", "app");
  const byPathname = new Map<string, SupplementStaticResponseMeta>();
  const prerenderManifest = readJsonIfExists(path.join(distDir, "prerender-manifest.json"));
  const prerenderRoutes = prerenderManifest?.routes;
  if (prerenderRoutes && typeof prerenderRoutes === "object") {
    for (const [pathname, raw] of Object.entries(prerenderRoutes)) {
      if (!pathname.startsWith("/") || !raw || typeof raw !== "object") continue;
      const sourceRel = appStaticBodySourceRel(pathname);
      if (!sourceRel) continue;
      const item = raw as Record<string, unknown>;
      const statusValue = item.initialStatus ?? item.status;
      const status = typeof statusValue === "number" && Number.isInteger(statusValue)
        ? statusValue
        : undefined;
      const headers = normalizeResponseHeaders(item.initialHeaders);
      if (status === undefined && headers.length === 0) continue;
      mergeStaticResponseMeta(byPathname, {
        pathname,
        sourceRel,
        ...(status !== undefined ? { status } : {}),
        headers,
      });
    }
  }
  for (const filePath of walkFiles(appDir).filter((file) => file.endsWith(".meta"))) {
    const bodyFile = filePath.slice(0, -".meta".length) + ".body";
    if (!fs.existsSync(bodyFile)) continue;
    const meta = responseMetaFromJson(readJsonIfExists(filePath));
    if (!meta) continue;
    const sourceRel = path.relative(appDir, filePath).split(path.sep).join("/");
    const pathname = appStaticMetaPathname(sourceRel);
    mergeStaticResponseMeta(byPathname, {
      pathname,
      sourceRel,
      ...meta,
    });
  }
  return Array.from(byPathname.values()).sort((a, b) => a.pathname.localeCompare(b.pathname));
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
      ...(item.locale === false ? { locale: false as const } : {}),
    });
  }
  return redirects;
}

function extractRewriteArray(value: unknown): SupplementRewrite[] {
  if (!Array.isArray(value)) return [];
  const rewrites: SupplementRewrite[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.regex !== "string"
      || typeof item.destination !== "string"
    ) continue;
    rewrites.push({
      regex: item.regex,
      source: typeof item.source === "string" ? item.source : "",
      destination: item.destination,
      ...(item.locale === false ? { locale: false as const } : {}),
    });
  }
  return rewrites;
}

export function extractRewriteSupplement(distDir: string): SupplementRewritePhases {
  const raw = readJsonIfExists(path.join(distDir, "routes-manifest.json"));
  const rewrites = raw?.rewrites;
  return {
    beforeFiles: extractRewriteArray(rewrites?.beforeFiles),
    afterFiles: extractRewriteArray(rewrites?.afterFiles),
    fallback: extractRewriteArray(rewrites?.fallback),
  };
}

export function extractStaticRouteSupplement(distDir: string): SupplementStaticRoute[] {
  const raw = readJsonIfExists(path.join(distDir, "routes-manifest.json"));
  if (!raw || !Array.isArray(raw.staticRoutes)) return [];
  const staticRoutes: SupplementStaticRoute[] = [];
  for (const item of raw.staticRoutes) {
    if (!item || typeof item !== "object") continue;
    const page = (item as Record<string, unknown>).page;
    const namedRegex = (item as Record<string, unknown>).namedRegex;
    const regex = (item as Record<string, unknown>).regex;
    if (typeof page !== "string" || page.length === 0) continue;
    const routeRegex = typeof namedRegex === "string" && namedRegex.length > 0
      ? namedRegex
      : regex;
    if (typeof routeRegex !== "string" || routeRegex.length === 0) continue;
    staticRoutes.push({ page, regex: routeRegex });
  }
  return staticRoutes;
}

export function extractPprSegmentPrefetchRoutes(
  distDir: string,
): SupplementPrefetchSegmentDataRoute[] {
  const raw = readJsonIfExists(path.join(distDir, "routes-manifest.json"));
  if (!raw || !Array.isArray(raw.dynamicRoutes)) return [];
  const routes: SupplementPrefetchSegmentDataRoute[] = [];
  for (const dynamicRoute of raw.dynamicRoutes) {
    if (!dynamicRoute || typeof dynamicRoute !== "object") continue;
    const record = dynamicRoute as Record<string, unknown>;
    const page = record.page;
    const prefetchRoutes = record.prefetchSegmentDataRoutes;
    if (typeof page !== "string" || !Array.isArray(prefetchRoutes)) continue;
    for (const rawPrefetch of prefetchRoutes) {
      if (!rawPrefetch || typeof rawPrefetch !== "object") continue;
      const prefetch = rawPrefetch as Record<string, unknown>;
      if (
        typeof prefetch.source !== "string"
        || typeof prefetch.destination !== "string"
      ) continue;
      routes.push({
        page,
        source: prefetch.source,
        destination: prefetch.destination,
      });
    }
  }
  return routes;
}

export function createManifestSupplement(
  distDir: string,
  prerenders: readonly NormalizedOutput[] = [],
): ManifestSupplement {
  return {
    preview: extractPreviewConfig(distDir),
    pprPages: extractPprPages(distDir),
    appPrerenderDataRoutes: extractAppPrerenderDataRoutes(distDir, prerenders),
    pprSegmentPrefetchRoutes: extractPprSegmentPrefetchRoutes(distDir),
    prerenderResponseMeta: extractAppPrerenderResponseMeta(distDir),
    staticResponseMeta: extractAppStaticResponseMeta(distDir),
    dynamicPrerenderRoutes: extractDynamicPrerenderRoutes(distDir),
    redirects: extractRedirectSupplement(distDir),
    rewrites: extractRewriteSupplement(distDir),
    staticRoutes: extractStaticRouteSupplement(distDir),
  };
}
