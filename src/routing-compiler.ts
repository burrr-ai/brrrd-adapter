import type {
  AdapterRouteCondition,
  AdapterRouteEntry,
  NextBuildModel,
  NormalizedOutput,
} from "./model.js";
import type {
  ManifestSupplement,
  SupplementAppPrerenderDataRoute,
  SupplementDynamicPrerenderRoute,
  SupplementPrefetchSegmentDataRoute,
  SupplementPrerenderResponseMeta,
  SupplementStaticResponseMeta,
  SupplementRedirect,
  SupplementRewrite,
  SupplementStaticRoute,
} from "./manifest-supplement.js";
import {
  publicArtifactPathnames,
  publicStorageFilePath,
} from "./public-storage.js";
import { routeRegexFromPathname } from "./route-pattern.js";
import type {
  BrrrdHeaderRule,
  BrrrdHeaderPair,
  BrrrdRoutingI18n,
  BrrrdRedirect,
  BrrrdRewrite,
  BrrrdRouting,
  BrrrdRoute,
  BrrrdMiddlewareCondition,
} from "./types.js";
import {
  isAuxiliaryPrerenderPath,
  isRouteHandlerPrerender,
} from "./prerender-classifier.js";
import { sanitizeId } from "./routing.js";
import { basePath } from "./next-config.js";
import {
  pagesDynamicFallbackPublicPathname,
  pagesDynamicFallbackPublicPathnames,
} from "./pages-dynamic-prerender.js";
import { isPagesRscFallbackOutput, pagesStaticDataPathname } from "./pages-static-data.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trailingSlashEnabled(config: unknown): boolean {
  return Boolean(
    config
    && typeof config === "object"
    && (config as { trailingSlash?: unknown }).trailingSlash === true,
  );
}

function looksLikeFilePath(pathname: string): boolean {
  const lastSegment = pathname.split("/").filter(Boolean).at(-1) ?? "";
  return lastSegment.includes(".");
}

function exactPathPattern(pathname: string, config: unknown): string {
  const normalized = pathname !== "/" && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
  if (
    trailingSlashEnabled(config)
    && normalized !== "/"
    && !looksLikeFilePath(normalized)
  ) {
    return `^${escapeRegex(normalized)}(?:/)?$`;
  }
  return `^${escapeRegex(normalized)}$`;
}

function normalizeConditions(
  conditions: AdapterRouteCondition[] | undefined,
): BrrrdMiddlewareCondition[] | undefined {
  if (!Array.isArray(conditions) || conditions.length === 0) return undefined;
  const out: BrrrdMiddlewareCondition[] = [];
  for (const condition of conditions) {
    if (
      condition.type !== "header"
      && condition.type !== "cookie"
      && condition.type !== "query"
      && condition.type !== "host"
    ) continue;
    if (condition.type !== "host" && (!condition.key || condition.key.length === 0)) {
      continue;
    }
    out.push({
      type: condition.type,
      ...(condition.key ? { key: condition.key } : {}),
      ...(typeof condition.value === "string" ? { value: condition.value } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function sourceFor(route: AdapterRouteEntry): string {
  return typeof route.source === "string" ? route.source : "";
}

function locationHeader(route: AdapterRouteEntry): string | undefined {
  if (!route.headers) return undefined;
  const pair = Object.entries(route.headers)
    .find(([key]) => key.toLowerCase() === "location");
  return pair?.[1];
}

function findRedirectSupplement(
  route: AdapterRouteEntry,
  redirects: SupplementRedirect[],
): SupplementRedirect | undefined {
  return redirects.find((redirect) => (
    redirect.regex === route.sourceRegex
    || (route.source && redirect.source === route.source)
  ));
}

function findRewriteSupplement(
  route: AdapterRouteEntry,
  rewrites: SupplementRewrite[],
): SupplementRewrite | undefined {
  return rewrites.find((rewrite) => (
    rewrite.regex === route.sourceRegex
    || (route.source && rewrite.source === route.source)
    || (route.destination && rewrite.destination === route.destination && rewrite.regex === route.sourceRegex)
  ));
}

function localeDisabled(route: AdapterRouteEntry, supplement?: { locale?: false }): false | undefined {
  const routeLocale = (route as { locale?: unknown }).locale;
  return routeLocale === false || supplement?.locale === false ? false : undefined;
}

function headerRule(route: AdapterRouteEntry, redirectSupplement?: SupplementRedirect): BrrrdHeaderRule | null {
  if (redirectSupplement || (locationHeader(route) && typeof route.status === "number")) {
    return null;
  }
  if (!route.headers || Object.keys(route.headers).length === 0) return null;
  const has = normalizeConditions(route.has);
  const missing = normalizeConditions(route.missing);
  return {
    regex: route.sourceRegex,
    source: sourceFor(route),
    headers: Object.entries(route.headers).map(([key, value]) => ({ key, value })),
    ...(has ? { has } : {}),
    ...(missing ? { missing } : {}),
  };
}

function redirectRule(
  route: AdapterRouteEntry,
  redirectSupplement?: SupplementRedirect,
): BrrrdRedirect | null {
  const location = locationHeader(route);
  if (redirectSupplement) {
    const has = normalizeConditions(route.has);
    const missing = normalizeConditions(route.missing);
    return {
      regex: route.sourceRegex,
      source: sourceFor(route) || redirectSupplement.source,
      destination: redirectSupplement.destination,
      statusCode: redirectSupplement.statusCode,
      ...(localeDisabled(route, redirectSupplement) === false ? { locale: false as const } : {}),
      ...(has ? { has } : {}),
      ...(missing ? { missing } : {}),
      ...(route.internal === true ? { internal: true } : {}),
    };
  }
  if (!route.destination && !location) return null;
  if (typeof route.status !== "number") return null;
  const has = normalizeConditions(route.has);
  const missing = normalizeConditions(route.missing);
  return {
    regex: route.sourceRegex,
    source: sourceFor(route),
    destination: route.destination ?? location ?? "",
    statusCode: route.status,
    ...(localeDisabled(route) === false ? { locale: false as const } : {}),
    ...(has ? { has } : {}),
    ...(missing ? { missing } : {}),
    ...(route.internal === true ? { internal: true } : {}),
  };
}

function rewriteRule(route: AdapterRouteEntry, supplement?: SupplementRewrite): BrrrdRewrite | null {
  if (!route.destination) return null;
  const has = normalizeConditions(route.has);
  const missing = normalizeConditions(route.missing);
  return {
    regex: route.sourceRegex,
    source: sourceFor(route) || supplement?.source || "",
    destination: route.destination,
    ...(localeDisabled(route, supplement) === false ? { locale: false as const } : {}),
    ...(has ? { has } : {}),
    ...(missing ? { missing } : {}),
  };
}

function stripOptionalTrailingSlashFromRegex(regex: string): string | null {
  if (!regex.startsWith("^")) return null;
  return regex
    .slice(1)
    .replace(/\(\?:\\?\/\)\?\$$/, "")
    .replace(/\\?\/\?\$$/, "")
    .replace(/\$$/, "");
}

function splitPathAndQuery(value: string): { pathname: string; query: string } {
  const queryIndex = value.indexOf("?");
  if (queryIndex === -1) return { pathname: value, query: "" };
  return {
    pathname: value.slice(0, queryIndex),
    query: value.slice(queryIndex + 1),
  };
}

function pagesDataPathname(model: NextBuildModel, pathname: string): string | null {
  if (!pathname.startsWith("/")) return null;
  const configuredBasePath = basePath(model.config);
  const dataRoot = `${configuredBasePath}/_next/data/${model.buildId}`;
  if (pathname.startsWith(`${dataRoot}/`)) return null;
  let pagePath = pathname;
  if (pagePath !== "/" && pagePath.endsWith("/")) pagePath = pagePath.slice(0, -1);
  if (pagePath === "/") pagePath = "/index";
  return `${dataRoot}${pagePath}.json`;
}

function pagesDataRewriteRule(model: NextBuildModel, route: BrrrdRewrite): BrrrdRewrite | null {
  if (!route.destination.startsWith("/") || route.destination.startsWith("//")) return null;
  if (route.regex.includes("/_next/data/") || route.destination.includes("/_next/data/")) {
    return null;
  }
  const sourceBody = stripOptionalTrailingSlashFromRegex(route.regex);
  if (!sourceBody) return null;
  const configuredBasePath = basePath(model.config);
  const dataRoot = `${configuredBasePath}/_next/data/${model.buildId}`;
  const { pathname, query } = splitPathAndQuery(route.destination);
  const dataDestination = pagesDataPathname(model, pathname);
  if (!dataDestination) return null;
  const source = route.source ? pagesDataPathname(model, route.source) ?? "" : "";
  return {
    ...route,
    regex: `^${escapeRegex(dataRoot)}${sourceBody}\\.json$`,
    source,
    destination: `${dataDestination}${query ? `?${query}` : ""}`,
  };
}

function expandPagesDataRewriteRules(
  model: NextBuildModel,
  routes: BrrrdRewrite[],
): BrrrdRewrite[] {
  const out: BrrrdRewrite[] = [];
  for (const route of routes) {
    out.push(route);
    const dataRoute = pagesDataRewriteRule(model, route);
    if (dataRoute) out.push(dataRoute);
  }
  return out;
}

function routingI18n(config: unknown): BrrrdRoutingI18n | undefined {
  if (!config || typeof config !== "object") return undefined;
  const record = config as { i18n?: unknown; basePath?: unknown };
  const i18n = record.i18n;
  if (!i18n || typeof i18n !== "object") return undefined;
  const i18nRecord = i18n as {
    locales?: unknown;
    defaultLocale?: unknown;
    localeDetection?: unknown;
  };
  if (
    !Array.isArray(i18nRecord.locales)
    || typeof i18nRecord.defaultLocale !== "string"
    || i18nRecord.defaultLocale.length === 0
  ) return undefined;
  const locales = i18nRecord.locales
    .filter((locale): locale is string => typeof locale === "string" && locale.length > 0);
  if (locales.length === 0) return undefined;
  return {
    locales,
    defaultLocale: i18nRecord.defaultLocale,
    ...(typeof record.basePath === "string" && record.basePath.length > 0
      ? { basePath: record.basePath }
      : {}),
    ...(i18nRecord.localeDetection === false ? { localeDetection: false as const } : {}),
  };
}

export function compileRouting(
  model: NextBuildModel,
  supplement?: Pick<ManifestSupplement, "redirects" | "rewrites">,
): BrrrdRouting {
  const headers: BrrrdHeaderRule[] = [];
  const redirects: BrrrdRedirect[] = [];
  for (const route of model.routing.beforeMiddleware) {
    const supplementRedirect = findRedirectSupplement(route, supplement?.redirects ?? []);
    const h = headerRule(route, supplementRedirect);
    if (h) headers.push(h);
    const r = redirectRule(route, supplementRedirect);
    if (r) redirects.push(r);
  }

  const beforeFiles = expandPagesDataRewriteRules(
    model,
    model.routing.beforeFiles
      .map((route) => rewriteRule(
        route,
        findRewriteSupplement(route, supplement?.rewrites?.beforeFiles ?? []),
      ))
      .filter((route): route is BrrrdRewrite => route !== null),
  );
  const afterFiles = expandPagesDataRewriteRules(
    model,
    model.routing.afterFiles
      .map((route) => rewriteRule(
        route,
        findRewriteSupplement(route, supplement?.rewrites?.afterFiles ?? []),
      ))
      .filter((route): route is BrrrdRewrite => route !== null),
  );
  const fallback = expandPagesDataRewriteRules(
    model,
    model.routing.fallback
      .map((route) => rewriteRule(
        route,
        findRewriteSupplement(route, supplement?.rewrites?.fallback ?? []),
      ))
      .filter((route): route is BrrrdRewrite => route !== null),
  );

  const i18n = routingI18n(model.config);
  return {
    ...(i18n ? { i18n } : {}),
    headers,
    redirects,
    proxy: null,
    rewrites: {
      beforeFiles,
      afterFiles,
      fallback,
    },
  };
}

function segmentParamNames(pathname: string): string[] {
  const params: string[] = [];
  const dynamicToken = /\[\[\.\.\.([^\]]+)\]\]|\[\.\.\.([^\]]+)\]|\[([^\]]+)\]/g;
  for (const match of pathname.matchAll(dynamicToken)) {
    params.push(match[1] ?? match[2] ?? match[3]);
  }
  return params;
}

function segmentParamTypes(
  pathname: string,
): Record<string, "single" | "catchAll" | "optionalCatchAll"> | undefined {
  const params: Record<string, "single" | "catchAll" | "optionalCatchAll"> = {};
  const dynamicToken = /\[\[\.\.\.([^\]]+)\]\]|\[\.\.\.([^\]]+)\]|\[([^\]]+)\]/g;
  for (const match of pathname.matchAll(dynamicToken)) {
    if (match[1]) params[match[1]] = "optionalCatchAll";
    else if (match[2]) params[match[2]] = "catchAll";
    else if (match[3]) params[match[3]] = "single";
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

function stripQuery(value: string): string {
  return value.split("?")[0];
}

function defaultLocale(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const i18n = (config as { i18n?: unknown }).i18n;
  if (!i18n || typeof i18n !== "object") return null;
  const value = (i18n as { defaultLocale?: unknown }).defaultLocale;
  return typeof value === "string" && value.length > 0 ? value : null;
}

type DynamicRegexIndex = {
  fallbackByRoutePath: Map<string, string>;
  dataByRoutePath: Map<string, string>;
  pageByRoutePath: Map<string, string>;
};

function isNextDataRoute(route: AdapterRouteEntry): boolean {
  return route.sourceRegex.includes("/_next/data/")
    || stripQuery(route.destination ?? "").includes("/_next/data/");
}

function isNextDataOutput(output: NormalizedOutput): boolean {
  return output.pathname.includes("/_next/data/");
}

function setOnce(map: Map<string, string>, key: string | undefined, value: string): void {
  if (!key || map.has(key)) return;
  map.set(key, value);
}

function dynamicRegexIndex(
  model: NextBuildModel,
  dynamicPrerenderRoutes: SupplementDynamicPrerenderRoute[] | undefined,
): DynamicRegexIndex {
  const fallbackByRoutePath = new Map<string, string>();
  const dataByRoutePath = new Map<string, string>();
  const pageByRoutePath = new Map<string, string>();
  for (const route of dynamicPrerenderRoutes ?? []) {
    setOnce(pageByRoutePath, route.page, route.routeRegex);
    setOnce(fallbackByRoutePath, route.page, route.routeRegex);
  }
  for (const route of model.routing.dynamicRoutes) {
    const destination = route.destination ? stripQuery(route.destination) : undefined;
    const targetMap = isNextDataRoute(route) ? dataByRoutePath : pageByRoutePath;
    setOnce(targetMap, route.source, route.sourceRegex);
    setOnce(targetMap, destination, route.sourceRegex);
    setOnce(fallbackByRoutePath, route.source, route.sourceRegex);
    setOnce(fallbackByRoutePath, destination, route.sourceRegex);
  }
  return { fallbackByRoutePath, dataByRoutePath, pageByRoutePath };
}

function dynamicRegexForOutput(
  model: NextBuildModel,
  output: NormalizedOutput,
  index: DynamicRegexIndex,
): string | undefined {
  const sourcePathname = sourcePagePathname(model, output);
  if (isNextDataOutput(output)) {
    return index.dataByRoutePath.get(sourcePathname)
      ?? index.dataByRoutePath.get(output.pathname)
      ?? index.fallbackByRoutePath.get(sourcePathname)
      ?? index.fallbackByRoutePath.get(output.pathname);
  }
  return index.pageByRoutePath.get(sourcePathname)
    ?? index.pageByRoutePath.get(output.pathname)
    ?? index.fallbackByRoutePath.get(sourcePathname)
    ?? index.fallbackByRoutePath.get(output.pathname);
}

function i18nLocales(config: unknown): string[] {
  if (!config || typeof config !== "object") return [];
  const i18n = (config as { i18n?: unknown }).i18n;
  if (!i18n || typeof i18n !== "object") return [];
  const locales = (i18n as { locales?: unknown }).locales;
  if (!Array.isArray(locales)) return [];
  return locales.filter((locale): locale is string => typeof locale === "string" && locale.length > 0);
}

function sourcePagePathname(model: NextBuildModel, output: NormalizedOutput): string {
  const configuredBasePath = basePath(model.config);
  const pathname = output.pagesRoutePath
    ? output.pagesRoutePath === "/" && configuredBasePath
      ? configuredBasePath
      : `${configuredBasePath}${output.pagesRoutePath}`
    : output.pathname;
  for (const locale of i18nLocales(model.config)) {
    const prefix = `/${locale}/`;
    if (pathname.startsWith(prefix)) {
      return `/${pathname.slice(prefix.length)}`;
    }
    if (pathname === `/${locale}`) return "/";
  }
  return pathname;
}

function canonicalAppPagePathname(pathname: string | undefined): string | undefined {
  if (!pathname) return undefined;
  if (pathname.endsWith(".rsc")) return pathname.slice(0, -".rsc".length);
  const segmentIndex = pathname.indexOf(".segments/");
  if (segmentIndex !== -1) return pathname.slice(0, segmentIndex);
  return pathname;
}

function dynamicPrerenderRouteByPage(
  routes: SupplementDynamicPrerenderRoute[] | undefined,
): Map<string, SupplementDynamicPrerenderRoute> {
  const out = new Map<string, SupplementDynamicPrerenderRoute>();
  for (const route of routes ?? []) out.set(route.page, route);
  return out;
}

function staticRegexByRoutePath(
  staticRoutes: SupplementStaticRoute[] | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const route of staticRoutes ?? []) {
    out.set(route.page, route.regex);
  }
  return out;
}

function hasInterceptMarker(pathname: string): boolean {
  return pathname.split("/").some((segment) => /^\(\.{1,3}\)/.test(segment));
}

function routeSegments(pathname: string): string[] {
  return pathname.replace(/^\//, "").split("/").filter(Boolean);
}

function segmentKind(segment: string): number {
  if (segment.includes("[[...")) return 0;
  if (segment.includes("[...")) return 1;
  if (segment.includes("[")) return 2;
  return 3;
}

function staticCharCount(segment: string): number {
  return segment
    .replace(/\[\[\.\.\.[^\]]+\]\]/g, "")
    .replace(/\[\.\.\.[^\]]+\]/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .length;
}

function compareRouteSpecificity(a: { pathname: string }, b: { pathname: string }): number {
  const aSegments = routeSegments(a.pathname);
  const bSegments = routeSegments(b.pathname);
  const max = Math.max(aSegments.length, bSegments.length);

  for (let i = 0; i < max; i++) {
    const aSegment = aSegments[i];
    const bSegment = bSegments[i];
    if (aSegment === undefined) return 1;
    if (bSegment === undefined) return -1;

    const kindDelta = segmentKind(bSegment) - segmentKind(aSegment);
    if (kindDelta !== 0) return kindDelta;

    const staticDelta = staticCharCount(bSegment) - staticCharCount(aSegment);
    if (staticDelta !== 0) return staticDelta;
  }

  return a.pathname.localeCompare(b.pathname);
}

function sortBySpecificity<T extends { pathname: string }>(routes: T[]): T[] {
  return [...routes].sort(compareRouteSpecificity);
}

function exactRoute(
  model: NextBuildModel,
  output: NormalizedOutput,
  type: "page" | "route",
  staticRegexes: Map<string, string>,
  pprResumes: Map<string, BrrrdRoute["pprResume"]> = new Map(),
): BrrrdRoute {
  const pprResume = pprResumeForOutput(output, pprResumes);
  const intercepted = hasInterceptMarker(output.pathname);
  return {
    id: sanitizeId(output.id),
    pattern: staticRegexes.get(output.urlPath)
      ?? staticRegexes.get(output.pathname)
      ?? exactPathPattern(output.urlPath, model.config),
    type,
    ...runtimeTarget(output),
    ...(pprResume ? { pprResume } : {}),
    ...(intercepted ? { intercepted: true } : {}),
  };
}

function publicRoute(
  model: NextBuildModel,
  output: NormalizedOutput,
  type: "static" | "prerender",
  file: string,
  immutable?: boolean,
  responseMeta?: { status?: number; headers?: BrrrdHeaderPair[] },
  ppr?: boolean,
): BrrrdRoute {
  const dynamicPublicTemplate = output.kind !== "public" && output.pathname.includes("[");
  return {
    id: `${type}-${sanitizeId(output.urlPath)}`,
    pattern: dynamicPublicTemplate
      ? routeRegexFromPathname(output.pathname)
      : exactPathPattern(output.urlPath, model.config),
    type,
    runtime: "nodejs",
    bundle: "",
    file,
    ...(immutable !== undefined ? { immutable } : {}),
    ...(ppr ? { ppr: true } : {}),
    ...(responseMeta?.status !== undefined ? { status: responseMeta.status } : {}),
    ...(responseMeta?.headers && responseMeta.headers.length > 0
      ? { headers: responseMeta.headers }
      : {}),
    ...(dynamicPublicTemplate ? { params: segmentParamNames(output.pathname) } : {}),
    ...(dynamicPublicTemplate ? { paramTypes: segmentParamTypes(output.pathname) } : {}),
  };
}

function publicRouteAlias(
  model: NextBuildModel,
  route: BrrrdRoute,
  aliasPathname: string,
  aliasKind: "default-locale" | "encoded",
): BrrrdRoute {
  const { params: _params, paramTypes: _paramTypes, ...rest } = route;
  return {
    ...rest,
    id: `${route.id}-${aliasKind}-alias`,
    pattern: exactPathPattern(aliasPathname, model.config),
  };
}

function executableRouteAlias(
  model: NextBuildModel,
  route: BrrrdRoute,
  aliasPathname: string,
): BrrrdRoute {
  const { params: _params, paramTypes: _paramTypes, ...rest } = route;
  return {
    ...rest,
    pattern: exactPathPattern(aliasPathname, model.config),
  };
}

function executableDynamicRouteAlias(
  route: BrrrdRoute,
  aliasPathname: string,
): BrrrdRoute {
  return {
    ...route,
    pattern: routeRegexFromPathname(aliasPathname),
    params: segmentParamNames(aliasPathname),
    paramTypes: segmentParamTypes(aliasPathname),
    localeHandling: "unprefixed",
  };
}

function pprSegmentStoragePattern(sourceRegex: string): string {
  if (!sourceRegex.startsWith("^/")) return sourceRegex;
  const optionalSlashSuffix = "(?:/)?$";
  if (sourceRegex.endsWith(optionalSlashSuffix)) {
    const body = sourceRegex.slice(2, -optionalSlashSuffix.length);
    return `^/(${body})${optionalSlashSuffix}`;
  }
  if (sourceRegex.endsWith("$")) {
    const body = sourceRegex.slice(2, -1);
    return `^/(${body})$`;
  }
  return sourceRegex;
}

function pprSegmentPrefetchRoute(
  route: SupplementPrefetchSegmentDataRoute,
  index: number,
): BrrrdRoute {
  return {
    id: `ppr-segment-${sanitizeId(route.page)}-${index}`,
    pattern: pprSegmentStoragePattern(route.source),
    type: "static",
    runtime: "nodejs",
    bundle: "",
    file: route.destination,
    params: ["path"],
  };
}

function appPrerenderDataRoute(
  model: NextBuildModel,
  route: SupplementAppPrerenderDataRoute,
): BrrrdRoute {
  return {
    id: `app-prerender-data-${sanitizeId(route.pathname)}`,
    pattern: exactPathPattern(route.pathname, model.config),
    type: "static",
    runtime: "nodejs",
    bundle: "",
    file: route.pathname,
  };
}

function pagesStaticDataRoute(
  model: NextBuildModel,
  output: NormalizedOutput,
): BrrrdRoute | null {
  const pathname = pagesStaticDataPathname(model, output);
  if (!pathname) return null;
  return {
    id: `pages-static-data-${sanitizeId(output.urlPath)}`,
    pattern: exactPathPattern(pathname, model.config),
    type: "static",
    runtime: "nodejs",
    bundle: "",
    file: pathname,
  };
}

function imageOptimizerRoute(model: NextBuildModel): BrrrdRoute {
  const pathname = `${basePath(model.config)}/_next/image`;
  return {
    id: "_next_image",
    pattern: `^${escapeRegex(pathname)}(?:/)?$`,
    type: "image-optimizer",
    runtime: "nodejs",
    bundle: "",
  };
}

function encodedPublicPathnameAlias(pathname: string): string | null {
  const encoded = pathname.split("/").map((segment, index) => {
    if (index === 0) return "";
    return encodeURIComponent(segment);
  }).join("/");
  return encoded !== pathname ? encoded : null;
}

function defaultLocaleAliasPathname(
  model: NextBuildModel,
  pathname: string,
): string | null {
  const locale = defaultLocale(model.config);
  if (!locale) return null;
  const configuredBasePath = basePath(model.config);

  const publicLocalePath = `${configuredBasePath}/${locale}`;
  const publicRoutePrefix = `${publicLocalePath}/`;
  if (pathname === publicLocalePath) {
    return configuredBasePath || "/";
  }
  if (pathname.startsWith(publicRoutePrefix)) {
    return `${configuredBasePath}/${pathname.slice(publicRoutePrefix.length)}`;
  }

  const dataRoot = `${configuredBasePath}/_next/data/${model.buildId}`;
  const dataPrefix = `${dataRoot}/${locale}/`;
  if (pathname === `${dataRoot}/${locale}.json`) {
    return `${dataRoot}/index.json`;
  }
  if (pathname.startsWith(dataPrefix)) {
    return `${dataRoot}/${pathname.slice(dataPrefix.length)}`;
  }

  return null;
}

function prerenderResponseMetaByPathname(
  metas: readonly SupplementPrerenderResponseMeta[] | undefined,
): Map<string, SupplementPrerenderResponseMeta> {
  const out = new Map<string, SupplementPrerenderResponseMeta>();
  for (const meta of metas ?? []) out.set(meta.pathname, meta);
  return out;
}

function staticResponseMetaByPathname(
  metas: readonly SupplementStaticResponseMeta[] | undefined,
): Map<string, SupplementStaticResponseMeta> {
  const out = new Map<string, SupplementStaticResponseMeta>();
  for (const meta of metas ?? []) out.set(meta.pathname, meta);
  return out;
}

function inferredNextStaticResponseMeta(
  output: NormalizedOutput,
  responseMeta?: { status?: number; headers?: BrrrdHeaderPair[] },
): { status?: number; headers?: BrrrdHeaderPair[] } | undefined {
  if (responseMeta) return responseMeta;
  if (
    output.kind === "public"
    || !output.pathname.includes("[")
    || !output.filePath?.endsWith(".html")
  ) {
    return undefined;
  }
  return { headers: [{ key: "content-type", value: "text/html; charset=utf-8" }] };
}

function dynamicRoute(
  model: NextBuildModel,
  output: NormalizedOutput,
  type: "page" | "route",
  sourceRegex: string,
  options: {
    paramsPathname?: string | null;
    previewOnly?: boolean;
    staticPathsOnly?: boolean;
    prerenderBypass?: BrrrdRoute["prerenderBypass"];
    pprResume?: BrrrdRoute["pprResume"];
  } = {},
): BrrrdRoute {
  const sourcePathname = sourcePagePathname(model, output);
  const paramsPathname = options.paramsPathname === undefined
    ? sourcePathname
    : options.paramsPathname;
  const unprefixedI18nPage = type === "page"
    && i18nLocales(model.config).length > 0
    && sourcePathname === output.pathname
    && !sourceRegex.includes("nextLocale");
  return {
    id: sanitizeId(output.id),
    pattern: sourceRegex,
    type,
    ...runtimeTarget(output),
    ...(paramsPathname ? { params: segmentParamNames(paramsPathname) } : {}),
    ...(paramsPathname ? { paramTypes: segmentParamTypes(paramsPathname) } : {}),
    ...(unprefixedI18nPage ? { localeHandling: "unprefixed" as const } : {}),
    ...(options.previewOnly ? { previewOnly: true } : {}),
    ...(options.staticPathsOnly ? { staticPathsOnly: true } : {}),
    ...(options.prerenderBypass && options.prerenderBypass.length > 0
      ? { prerenderBypass: options.prerenderBypass }
      : {}),
    ...(options.pprResume ? { pprResume: options.pprResume } : {}),
    ...(hasInterceptMarker(output.pathname) ? { intercepted: true } : {}),
  };
}

function pprResumeByHandlerPath(model: NextBuildModel): Map<string, BrrrdRoute["pprResume"]> {
  const out = new Map<string, BrrrdRoute["pprResume"]>();
  for (const prerender of model.outputs.prerenders) {
    const postponedState = prerender.fallback?.postponedState;
    if (!prerender.pprChain || typeof postponedState !== "string") continue;
    const resume = {
      headers: prerender.pprChain.headers,
      postponedState,
    };
    out.set(prerender.pathname, resume);
    out.set(prerender.urlPath, resume);
  }
  return out;
}

function pprResumeForOutput(
  output: NormalizedOutput,
  pprResumes: Map<string, BrrrdRoute["pprResume"]>,
): BrrrdRoute["pprResume"] | undefined {
  return pprResumes.get(output.urlPath) ?? pprResumes.get(output.pathname);
}

function dynamicPrerenderRouteForOutput(
  model: NextBuildModel,
  output: NormalizedOutput,
  routesByPage: Map<string, SupplementDynamicPrerenderRoute>,
): SupplementDynamicPrerenderRoute | undefined {
  const candidates = [
    sourcePagePathname(model, output),
    output.pagesRoutePath,
    output.pathname,
    output.urlPath,
    canonicalAppPagePathname(sourcePagePathname(model, output)),
    canonicalAppPagePathname(output.pathname),
    canonicalAppPagePathname(output.urlPath),
  ].filter((item): item is string => typeof item === "string" && item.length > 0);
  for (const candidate of candidates) {
    const route = routesByPage.get(candidate);
    if (route) return route;
  }
  return undefined;
}

function dynamicPrerenderDataRoute(
  model: NextBuildModel,
  output: NormalizedOutput,
  routesByPage: Map<string, SupplementDynamicPrerenderRoute>,
  pprResumes: Map<string, BrrrdRoute["pprResume"]> = new Map(),
): BrrrdRoute | null {
  if (!output.pathname.includes("[")) return null;
  const route = dynamicPrerenderRouteForOutput(model, output, routesByPage);
  if (!route || !route.dataRouteRegex) return null;
  return dynamicRoute(model, output, "page", route.dataRouteRegex, {
    previewOnly: route.fallback === false,
    pprResume: pprResumeForOutput(output, pprResumes),
  });
}

function dynamicPrerenderFallbackRoute(
  model: NextBuildModel,
  route: SupplementDynamicPrerenderRoute,
  allPublicPathnames: readonly string[],
): BrrrdRoute | null {
  const pathname = pagesDynamicFallbackPublicPathname(model, route);
  if (!pathname) return null;
  return {
    id: `prerender-fallback-${sanitizeId(route.page)}`,
    pattern: route.routeRegex,
    type: "prerender",
    runtime: "nodejs",
    bundle: "",
    file: publicStorageFilePath(pathname, allPublicPathnames),
    headers: [{ key: "content-type", value: "text/html; charset=utf-8" }],
    pagesFallbackShell: true,
  };
}

function isEdgeOutput(output: NormalizedOutput): boolean {
  return output.runtime === "edge" || output.runtime === "experimental-edge";
}

function runtimeTarget(output: NormalizedOutput): Pick<BrrrdRoute, "runtime" | "edgeFunction"> {
  if (!isEdgeOutput(output)) return { runtime: "nodejs" };
  return {
    runtime: "edge",
    edgeFunction: sanitizeId(output.id),
  };
}

function handlerRoute(
  model: NextBuildModel,
  output: NormalizedOutput,
  type: "page" | "route",
  dynamicRegexes: DynamicRegexIndex,
  staticRegexes: Map<string, string>,
  dynamicPrerenders: Map<string, SupplementDynamicPrerenderRoute>,
  pprResumes: Map<string, BrrrdRoute["pprResume"]> = new Map(),
): BrrrdRoute | null {
  const pprResume = pprResumeForOutput(output, pprResumes);
  if (!output.pathname.includes("[")) return exactRoute(model, output, type, staticRegexes, pprResumes);
  const dynamicPrerender = dynamicPrerenderRouteForOutput(model, output, dynamicPrerenders);
  const appStaticPathsOnly = output.kind === "app-page" && dynamicPrerender?.fallback === false;
  const sourcePathname = sourcePagePathname(model, output);
  const sourceRegex = dynamicRegexForOutput(model, output, dynamicRegexes);
  const paramsPathname = undefined;
  const previewOnly = output.kind !== "app-page" && dynamicPrerender?.fallback === false;
  if (!sourceRegex) {
    if (hasInterceptMarker(output.pathname)) return null;
    return dynamicRoute(model, output, type, routeRegexFromPathname(sourcePathname), {
      paramsPathname,
      previewOnly,
      staticPathsOnly: appStaticPathsOnly,
      prerenderBypass: appStaticPathsOnly ? dynamicPrerender?.bypass : undefined,
      pprResume,
    });
  }
  return dynamicRoute(model, output, type, sourceRegex, {
    paramsPathname,
    previewOnly,
    staticPathsOnly: appStaticPathsOnly,
    prerenderBypass: appStaticPathsOnly ? dynamicPrerender?.bypass : undefined,
    pprResume,
  });
}

export function compileRouteTable(
  model: NextBuildModel,
  supplement?: Pick<
    ManifestSupplement,
    | "staticRoutes"
    | "dynamicPrerenderRoutes"
    | "appPrerenderDataRoutes"
    | "pprSegmentPrefetchRoutes"
    | "prerenderResponseMeta"
    | "staticResponseMeta"
    | "pprPages"
  >,
): BrrrdRoute[] {
  const routes: BrrrdRoute[] = [];
  const dynamicRegexes = dynamicRegexIndex(model, supplement?.dynamicPrerenderRoutes);
  const dynamicPrerenders = dynamicPrerenderRouteByPage(supplement?.dynamicPrerenderRoutes);
  const staticRegexes = staticRegexByRoutePath(supplement?.staticRoutes);
  const pprResumes = pprResumeByHandlerPath(model);
  const prerenderMeta = prerenderResponseMetaByPathname(supplement?.prerenderResponseMeta);
  const staticMeta = staticResponseMetaByPathname(supplement?.staticResponseMeta);
  const pprPages = new Set(supplement?.pprPages ?? []);
  const allPublicPathnames = [
    ...publicArtifactPathnames(model),
    ...pagesDynamicFallbackPublicPathnames(model, supplement?.dynamicPrerenderRoutes ?? []),
  ];

  routes.push({
    id: "_next_static",
    pattern: "^/_next/static/(.+)$",
    type: "static",
    runtime: "nodejs",
    bundle: "",
    file: "/_next/static/",
    immutable: true,
    params: ["path"],
  });
  routes.push(imageOptimizerRoute(model));

  for (const file of sortBySpecificity(model.outputs.staticFiles)) {
    if (file.urlPath.startsWith("/_next/static/")) continue;
    if (isPagesRscFallbackOutput(file)) continue;
    const route = publicRoute(
      model,
      file,
      "static",
      publicStorageFilePath(file.pathname, allPublicPathnames),
      !!file.immutableHash,
      inferredNextStaticResponseMeta(
        file,
        staticMeta.get(file.urlPath) ?? staticMeta.get(file.pathname),
      ),
    );
    routes.push(route);
    const alias = defaultLocaleAliasPathname(model, file.urlPath);
    if (alias) routes.push(publicRouteAlias(model, route, alias, "default-locale"));
    const encodedAlias = encodedPublicPathnameAlias(file.urlPath);
    if (encodedAlias) routes.push(publicRouteAlias(model, route, encodedAlias, "encoded"));
    const dataRoute = pagesStaticDataRoute(model, file);
    if (dataRoute) routes.push(dataRoute);
  }

  for (const pr of sortBySpecificity(model.outputs.prerenders)) {
    if (isAuxiliaryPrerenderPath(pr.pathname)) continue;
    if (isRouteHandlerPrerender(model, pr)) continue;
    const route = publicRoute(
      model,
      pr,
      "prerender",
      publicStorageFilePath(pr.pathname, allPublicPathnames),
      undefined,
      prerenderMeta.get(pr.pathname),
      pprPages.has(pr.pathname) || pprPages.has(pr.urlPath),
    );
    routes.push(route);
    const alias = defaultLocaleAliasPathname(model, pr.pathname);
    if (alias) routes.push(publicRouteAlias(model, route, alias, "default-locale"));
    const encodedAlias = encodedPublicPathnameAlias(pr.pathname);
    if (encodedAlias) routes.push(publicRouteAlias(model, route, encodedAlias, "encoded"));
  }

  for (const route of supplement?.appPrerenderDataRoutes ?? []) {
    const entry = appPrerenderDataRoute(model, route);
    routes.push(entry);
    const encodedAlias = encodedPublicPathnameAlias(route.pathname);
    if (encodedAlias) routes.push(publicRouteAlias(model, entry, encodedAlias, "encoded"));
  }

  for (const [index, route] of (supplement?.pprSegmentPrefetchRoutes ?? []).entries()) {
    routes.push(pprSegmentPrefetchRoute(route, index));
  }

  for (const dynamicPrerender of supplement?.dynamicPrerenderRoutes ?? []) {
    const route = dynamicPrerenderFallbackRoute(model, dynamicPrerender, allPublicPathnames);
    if (route) routes.push(route);
  }

  const allPages = [...model.outputs.appPages, ...model.outputs.pages];
  for (const page of sortBySpecificity(model.outputs.pages.filter((p) => p.pathname.includes("[")))) {
    const route = dynamicPrerenderDataRoute(model, page, dynamicPrerenders, pprResumes);
    if (route) routes.push(route);
  }

  const exactPages = sortBySpecificity(allPages.filter((p) => !p.pathname.includes("[")));
  const dynamicPages = sortBySpecificity(allPages.filter((p) => p.pathname.includes("[")));
  for (const page of exactPages) {
    const route = handlerRoute(model, page, "page", dynamicRegexes, staticRegexes, dynamicPrerenders, pprResumes);
    if (route) {
      routes.push(route);
      const alias = defaultLocaleAliasPathname(model, page.urlPath);
      if (alias) routes.push(executableRouteAlias(model, route, alias));
    }
  }
  for (const page of dynamicPages) {
    const route = handlerRoute(model, page, "page", dynamicRegexes, staticRegexes, dynamicPrerenders, pprResumes);
    if (route) {
      routes.push(route);
      const alias = defaultLocaleAliasPathname(model, page.urlPath);
      if (alias) routes.push(executableDynamicRouteAlias(route, alias));
    }
  }

  for (const routeOutput of sortBySpecificity(model.outputs.appRoutes)) {
    const route = handlerRoute(model, routeOutput, "route", dynamicRegexes, staticRegexes, dynamicPrerenders, pprResumes);
    if (route) routes.push(route);
  }

  for (const api of sortBySpecificity(model.outputs.pagesApi)) {
    const route = handlerRoute(model, api, "route", dynamicRegexes, staticRegexes, dynamicPrerenders, pprResumes);
    if (route) routes.push(route);
  }

  return routes;
}
