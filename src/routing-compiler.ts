import type {
  AdapterRouteCondition,
  AdapterRouteEntry,
  NextBuildModel,
  NormalizedOutput,
} from "./model.js";
import type { ManifestSupplement, SupplementRedirect } from "./manifest-supplement.js";
import type {
  BrrrdHeaderRule,
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
import {
  listPrerenderPathnames,
  prerenderStaticFile,
  sanitizeId,
} from "./routing.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    ...(has ? { has } : {}),
    ...(missing ? { missing } : {}),
  };
}

function rewriteRule(route: AdapterRouteEntry): BrrrdRewrite | null {
  if (!route.destination) return null;
  const has = normalizeConditions(route.has);
  const missing = normalizeConditions(route.missing);
  return {
    regex: route.sourceRegex,
    source: sourceFor(route),
    destination: route.destination,
    ...(has ? { has } : {}),
    ...(missing ? { missing } : {}),
  };
}

export function compileRouting(
  model: NextBuildModel,
  supplement?: Pick<ManifestSupplement, "redirects">,
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
    .map(rewriteRule)
    .filter((route): route is BrrrdRewrite => route !== null);
  const afterFiles = model.routing.afterFiles
    .map(rewriteRule)
    .filter((route): route is BrrrdRewrite => route !== null);
  const fallback = model.routing.fallback
    .map(rewriteRule)
    .filter((route): route is BrrrdRewrite => route !== null);

  return {
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

function exactRoute(output: NormalizedOutput, type: "page" | "route"): BrrrdRoute {
  return {
    id: sanitizeId(output.id),
    pattern: `^${escapeRegex(output.pathname)}$`,
    type,
    runtime: "nodejs",
  };
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
    runtime: "nodejs",
    params: segmentParamNames(output.pathname),
  };
}

function handlerRoute(
  output: NormalizedOutput,
  type: "page" | "route",
  dynamicRegexes: Map<string, string>,
): BrrrdRoute | null {
  if (!output.pathname.includes("[")) return exactRoute(output, type);
  const sourceRegex = dynamicRegexes.get(output.pathname);
  if (!sourceRegex) {
    if (hasInterceptMarker(output.pathname)) return null;
    throw new Error(
      `missing ctx.routing.dynamicRoutes sourceRegex for dynamic route ${output.pathname} (${output.id})`,
    );
  }
  return dynamicRoute(output, type, sourceRegex);
}

export function compileRouteTable(model: NextBuildModel): BrrrdRoute[] {
  const routes: BrrrdRoute[] = [];
  const dynamicRegexes = dynamicRegexByRoutePath(model);

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

  for (const file of model.outputs.staticFiles) {
    if (file.urlPath.startsWith("/_next/static/")) continue;
    routes.push({
      id: `static-${sanitizeId(file.urlPath)}`,
      pattern: `^${escapeRegex(file.urlPath)}$`,
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: file.pathname,
      immutable: !!file.immutableHash,
    });
  }

  const prerenderPaths = listPrerenderPathnames(model.outputs.prerenders);
  for (const pr of model.outputs.prerenders) {
    if (isAuxiliaryPrerenderPath(pr.pathname)) continue;
    if (isRouteHandlerPrerender(model, pr)) continue;
    routes.push({
      id: `prerender-${sanitizeId(pr.pathname)}`,
      pattern: `^${escapeRegex(pr.pathname)}$`,
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: prerenderStaticFile(pr.pathname, prerenderPaths),
    });
  }

  const allPages = [...model.outputs.appPages, ...model.outputs.pages];
  const exactPages = sortBySpecificity(allPages.filter((p) => !p.pathname.includes("[")));
  const dynamicPages = sortBySpecificity(allPages.filter((p) => p.pathname.includes("[")));
  for (const page of exactPages) {
    const route = handlerRoute(page, "page", dynamicRegexes);
    if (route) routes.push(route);
  }
  for (const page of dynamicPages) {
    const route = handlerRoute(page, "page", dynamicRegexes);
    if (route) routes.push(route);
  }

  for (const routeOutput of sortBySpecificity(model.outputs.appRoutes)) {
    const route = handlerRoute(routeOutput, "route", dynamicRegexes);
    if (route) routes.push(route);
  }

  for (const api of sortBySpecificity(model.outputs.pagesApi)) {
    const route = handlerRoute(api, "route", dynamicRegexes);
    if (route) routes.push(route);
  }

  return routes;
}
