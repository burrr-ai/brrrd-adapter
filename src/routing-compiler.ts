import type {
  AdapterRouteCondition,
  AdapterRouteEntry,
  NextBuildModel,
  NormalizedOutput,
} from "./model.js";
import type {
  ManifestSupplement,
  SupplementAppPrerenderDataRoute,
  SupplementPrefetchSegmentDataRoute,
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

function routingI18n(config: unknown): BrrrdRoutingI18n | undefined {
  if (!config || typeof config !== "object") return undefined;
  const record = config as { i18n?: unknown; basePath?: unknown };
  const i18n = record.i18n;
  if (!i18n || typeof i18n !== "object") return undefined;
  const i18nRecord = i18n as { locales?: unknown; defaultLocale?: unknown };
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

  const beforeFiles = model.routing.beforeFiles
    .map((route) => rewriteRule(
      route,
      findRewriteSupplement(route, supplement?.rewrites?.beforeFiles ?? []),
    ))
    .filter((route): route is BrrrdRewrite => route !== null);
  const afterFiles = model.routing.afterFiles
    .map((route) => rewriteRule(
      route,
      findRewriteSupplement(route, supplement?.rewrites?.afterFiles ?? []),
    ))
    .filter((route): route is BrrrdRewrite => route !== null);
  const fallback = model.routing.fallback
    .map((route) => rewriteRule(
      route,
      findRewriteSupplement(route, supplement?.rewrites?.fallback ?? []),
    ))
    .filter((route): route is BrrrdRewrite => route !== null);

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

function dynamicRegexByRoutePath(model: NextBuildModel): Map<string, string> {
  const out = new Map<string, string>();
  for (const route of model.routing.dynamicRoutes) {
    const keys = [
      route.source,
      route.destination ? stripQuery(route.destination) : undefined,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const key of keys) {
      out.set(key, route.sourceRegex);
    }
  }
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
  return pathname.split("/").some((segment) => segment.startsWith("(.)"));
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
): BrrrdRoute {
  return {
    id: sanitizeId(output.id),
    pattern: staticRegexes.get(output.pathname) ?? exactPathPattern(output.pathname, model.config),
    type,
    ...runtimeTarget(output),
  };
}

function publicRoute(
  model: NextBuildModel,
  output: NormalizedOutput,
  type: "static" | "prerender",
  file: string,
  immutable?: boolean,
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
    ...(dynamicPublicTemplate ? { params: segmentParamNames(output.pathname) } : {}),
  };
}

function publicRouteAlias(
  model: NextBuildModel,
  route: BrrrdRoute,
  aliasPathname: string,
): BrrrdRoute {
  const { params: _params, ...rest } = route;
  return {
    ...rest,
    id: `${route.id}-default-locale-alias`,
    pattern: exactPathPattern(aliasPathname, model.config),
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
    file: "/",
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

function defaultLocaleAliasPathname(
  model: NextBuildModel,
  pathname: string,
): string | null {
  const locale = defaultLocale(model.config);
  if (!locale) return null;

  const routePrefix = `/${locale}/`;
  if (pathname.startsWith(routePrefix)) {
    return `/${pathname.slice(routePrefix.length)}`;
  }

  const dataPrefix = `/_next/data/${model.buildId}/${locale}/`;
  if (pathname.startsWith(dataPrefix)) {
    return `/_next/data/${model.buildId}/${pathname.slice(dataPrefix.length)}`;
  }

  return null;
}

function dynamicRoute(
  output: NormalizedOutput,
  type: "page" | "route",
  sourceRegex: string,
): BrrrdRoute {
  return {
    id: sanitizeId(output.id),
    pattern: sourceRegex,
    type,
    ...runtimeTarget(output),
    params: segmentParamNames(output.pathname),
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
  dynamicRegexes: Map<string, string>,
  staticRegexes: Map<string, string>,
): BrrrdRoute | null {
  if (!output.pathname.includes("[")) return exactRoute(model, output, type, staticRegexes);
  const sourceRegex = dynamicRegexes.get(output.pathname);
  if (!sourceRegex) {
    if (hasInterceptMarker(output.pathname)) return null;
    return dynamicRoute(output, type, routeRegexFromPathname(output.pathname));
  }
  return dynamicRoute(output, type, sourceRegex);
}

export function compileRouteTable(
  model: NextBuildModel,
  supplement?: Pick<
    ManifestSupplement,
    "staticRoutes" | "appPrerenderDataRoutes" | "pprSegmentPrefetchRoutes"
  >,
): BrrrdRoute[] {
  const routes: BrrrdRoute[] = [];
  const dynamicRegexes = dynamicRegexByRoutePath(model);
  const staticRegexes = staticRegexByRoutePath(supplement?.staticRoutes);
  const allPublicPathnames = publicArtifactPathnames(model);

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

  for (const file of sortBySpecificity(model.outputs.staticFiles)) {
    if (file.urlPath.startsWith("/_next/static/")) continue;
    const route = publicRoute(
      model,
      file,
      "static",
      publicStorageFilePath(file.pathname, allPublicPathnames),
      !!file.immutableHash,
    );
    routes.push(route);
    const alias = defaultLocaleAliasPathname(model, file.urlPath);
    if (alias) routes.push(publicRouteAlias(model, route, alias));
  }

  for (const pr of sortBySpecificity(model.outputs.prerenders)) {
    if (isAuxiliaryPrerenderPath(pr.pathname)) continue;
    if (isRouteHandlerPrerender(model, pr)) continue;
    const route = publicRoute(
      model,
      pr,
      "prerender",
      publicStorageFilePath(pr.pathname, allPublicPathnames),
    );
    routes.push(route);
    const alias = defaultLocaleAliasPathname(model, pr.pathname);
    if (alias) routes.push(publicRouteAlias(model, route, alias));
  }

  for (const route of supplement?.appPrerenderDataRoutes ?? []) {
    routes.push(appPrerenderDataRoute(model, route));
  }

  for (const [index, route] of (supplement?.pprSegmentPrefetchRoutes ?? []).entries()) {
    routes.push(pprSegmentPrefetchRoute(route, index));
  }

  const allPages = [...model.outputs.appPages, ...model.outputs.pages];
  const exactPages = sortBySpecificity(allPages.filter((p) => !p.pathname.includes("[")));
  const dynamicPages = sortBySpecificity(allPages.filter((p) => p.pathname.includes("[")));
  for (const page of exactPages) {
    const route = handlerRoute(model, page, "page", dynamicRegexes, staticRegexes);
    if (route) routes.push(route);
  }
  for (const page of dynamicPages) {
    const route = handlerRoute(model, page, "page", dynamicRegexes, staticRegexes);
    if (route) routes.push(route);
  }

  for (const routeOutput of sortBySpecificity(model.outputs.appRoutes)) {
    const route = handlerRoute(model, routeOutput, "route", dynamicRegexes, staticRegexes);
    if (route) routes.push(route);
  }

  for (const api of sortBySpecificity(model.outputs.pagesApi)) {
    const route = handlerRoute(model, api, "route", dynamicRegexes, staticRegexes);
    if (route) routes.push(route);
  }

  return routes;
}
