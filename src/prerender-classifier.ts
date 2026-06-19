import type { NextBuildModel, NormalizedOutput } from "./model.js";

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
    || pathname.includes(".segment")
    || pathname.includes("[");
}
