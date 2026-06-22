import * as path from "node:path";

import type { NextBuildModel } from "./model.js";
import type { SupplementDynamicPrerenderRoute } from "./manifest-supplement.js";
import { basePath } from "./next-config.js";

function ensureLeadingSlash(pathname: string): string {
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function stripHtmlExtension(pathname: string): string | null {
  if (!pathname.endsWith(".html")) return null;
  const withoutExt = pathname.slice(0, -".html".length);
  return withoutExt === "" ? "/" : ensureLeadingSlash(withoutExt);
}

function stripBasePath(model: NextBuildModel, pathname: string): string {
  const configured = basePath(model.config);
  if (!configured) return pathname;
  if (pathname === configured) return "/";
  const prefix = `${configured}/`;
  return pathname.startsWith(prefix) ? `/${pathname.slice(prefix.length)}` : pathname;
}

export function pagesDynamicFallbackPublicPathname(
  model: NextBuildModel,
  route: SupplementDynamicPrerenderRoute,
): string | null {
  if (typeof route.fallback !== "string") return null;
  const pathname = stripHtmlExtension(route.fallback);
  if (!pathname) return null;
  const configured = basePath(model.config);
  if (!configured || pathname === configured || pathname.startsWith(`${configured}/`)) {
    return pathname;
  }
  return pathname === "/" ? configured : `${configured}${pathname}`;
}

export function pagesDynamicFallbackPublicPathnames(
  model: NextBuildModel,
  routes: readonly SupplementDynamicPrerenderRoute[],
): string[] {
  const out = new Set<string>();
  for (const route of routes) {
    const pathname = pagesDynamicFallbackPublicPathname(model, route);
    if (pathname) out.add(pathname);
  }
  return [...out];
}

export function pagesDynamicFallbackSourcePath(
  model: NextBuildModel,
  route: SupplementDynamicPrerenderRoute,
): string | null {
  const publicPathname = pagesDynamicFallbackPublicPathname(model, route);
  if (!publicPathname) return null;
  const sourcePathname = stripBasePath(model, publicPathname);
  const htmlName = sourcePathname === "/"
    ? "index.html"
    : `${sourcePathname.replace(/^\//, "")}.html`;
  return path.join(model.distDir, "server", "pages", htmlName);
}
