import type { NextBuildModel, NormalizedOutput } from "./model.js";
import type { SupplementDynamicPrerenderRoute } from "./manifest-supplement.js";
import { basePath, locales } from "./next-config.js";

export type PrerenderOwnerKind =
  | "app-page"
  | "page"
  | "app-route"
  | "pages-api"
  | "unknown";

export type PrerenderOwner = {
  kind: PrerenderOwnerKind;
  output?: NormalizedOutput;
};

function stripQuery(value: string): string {
  return value.split("?")[0];
}

function routeMatchesPathname(
  model: NextBuildModel,
  routePathname: string,
  prerenderPathname: string,
): boolean {
  if (routePathname === prerenderPathname) return true;
  if (!routePathname.includes("[")) return false;

  for (const route of model.routing.dynamicRoutes) {
    const keys = [
      route.source,
      route.destination ? stripQuery(route.destination) : undefined,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    if (!keys.includes(routePathname)) continue;
    try {
      if (new RegExp(route.sourceRegex).test(prerenderPathname)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function outputMatchesPrerender(
  model: NextBuildModel,
  output: NormalizedOutput,
  prerender: NormalizedOutput,
): boolean {
  if (prerender.parentOutputId && prerender.parentOutputId === output.id) return true;
  if (prerender.sourcePage && prerender.sourcePage === output.sourcePage) return true;
  if (prerender.id === output.id) return true;
  if (routeMatchesPathname(model, output.pathname, prerender.pathname)) return true;
  return false;
}

function findOwnerIn(
  model: NextBuildModel,
  prerender: NormalizedOutput,
  kind: PrerenderOwnerKind,
  outputs: NormalizedOutput[],
): PrerenderOwner | null {
  const output = outputs.find((candidate) => outputMatchesPrerender(model, candidate, prerender));
  return output ? { kind, output } : null;
}

export function findPrerenderOwner(
  model: NextBuildModel,
  prerender: NormalizedOutput,
): PrerenderOwner {
  return (
    findOwnerIn(model, prerender, "app-page", model.outputs.appPages)
    ?? findOwnerIn(model, prerender, "page", model.outputs.pages)
    ?? findOwnerIn(model, prerender, "app-route", model.outputs.appRoutes)
    ?? findOwnerIn(model, prerender, "pages-api", model.outputs.pagesApi)
    ?? { kind: "unknown" }
  );
}

export function isRouteHandlerPrerender(
  model: NextBuildModel,
  prerender: NormalizedOutput,
): boolean {
  const owner = findPrerenderOwner(model, prerender);
  return owner.kind === "app-route" || owner.kind === "pages-api";
}

export function isAuxiliaryPrerenderPath(pathname: string): boolean {
  return pathname.includes(".rsc")
    || pathname.includes(".segment");
}

function withoutBasePath(model: NextBuildModel, pathname: string): string {
  const configured = basePath(model.config);
  if (!configured) return pathname;
  if (pathname === configured) return "/";
  const prefix = `${configured}/`;
  return pathname.startsWith(prefix) ? `/${pathname.slice(prefix.length)}` : pathname;
}

function withoutLocale(model: NextBuildModel, pathname: string): string {
  const dataPrefix = `/_next/data/${model.buildId}/`;
  if (pathname.startsWith(dataPrefix)) {
    const rest = pathname.slice(dataPrefix.length);
    for (const locale of locales(model.config)) {
      if (rest === `${locale}.json`) return `${dataPrefix}index.json`;
      const localePrefix = `${locale}/`;
      if (rest.startsWith(localePrefix)) {
        return `${dataPrefix}${rest.slice(localePrefix.length)}`;
      }
    }
    return pathname;
  }

  for (const locale of locales(model.config)) {
    if (pathname === `/${locale}`) return "/";
    const prefix = `/${locale}/`;
    if (pathname.startsWith(prefix)) return `/${pathname.slice(prefix.length)}`;
  }
  return pathname;
}

export function isDynamicPrerenderTemplatePath(
  model: NextBuildModel,
  pathname: string,
  routes: readonly SupplementDynamicPrerenderRoute[] | undefined,
): boolean {
  if (!pathname.includes("[")) return false;
  const sourcePathname = withoutLocale(model, withoutBasePath(model, pathname));
  for (const route of routes ?? []) {
    if (
      pathname === route.page
      || pathname === route.dataRoute
      || sourcePathname === route.page
      || sourcePathname === route.dataRoute
    ) return true;
  }
  return false;
}
