import * as path from "node:path";

import type { NextBuildModel, NormalizedOutput } from "./model.js";
import { basePath } from "./next-config.js";

const NON_PAGE_DATA_ROUTES = new Set(["/404", "/500", "/_error"]);

function publicRoutePath(model: NextBuildModel, output: NormalizedOutput): string {
  const configured = basePath(model.config);
  if (!configured) return output.urlPath;
  if (output.urlPath === configured) return "/";
  const prefix = `${configured}/`;
  return output.urlPath.startsWith(prefix)
    ? `/${output.urlPath.slice(prefix.length)}`
    : output.urlPath;
}

export function isPagesStaticHtmlOutput(output: NormalizedOutput): boolean {
  return output.kind === "static"
    && typeof output.pagesRoutePath === "string"
    && typeof output.filePath === "string"
    && path.extname(output.filePath).toLowerCase() === ".html"
    && !output.pagesRoutePath.includes("[")
    && !NON_PAGE_DATA_ROUTES.has(output.pagesRoutePath);
}

// Automatically-static DYNAMIC Pages-Router pages (a dynamic route with no
// getStaticProps/getStaticPaths, hence absent from prerender-manifest dynamicRoutes).
// Next emits a per-locale `.html` template for them but NO prerendered data file; at
// runtime it renders `{ pageProps: {} }` for the `_next/data` request. The non-dynamic
// counterpart is handled by isPagesStaticHtmlOutput.
export function isPagesStaticDynamicHtmlOutput(output: NormalizedOutput): boolean {
  return output.kind === "static"
    && typeof output.pagesRoutePath === "string"
    && typeof output.filePath === "string"
    && path.extname(output.filePath).toLowerCase() === ".html"
    && output.pagesRoutePath.includes("[")
    && !NON_PAGE_DATA_ROUTES.has(output.pagesRoutePath);
}

// Stable mount path for the generated `{ pageProps: {} }` data artifact shared by all
// param values of an auto-static dynamic page. The compiled data route's `file` points
// here and the artifact planner writes the JSON here, keeping emitter/runtime aligned.
export function pagesStaticDynamicDataMountPath(
  model: NextBuildModel,
  output: NormalizedOutput,
): string | null {
  if (!isPagesStaticDynamicHtmlOutput(output)) return null;
  return `${basePath(model.config)}/_next/data/${model.buildId}${output.pathname}.json`;
}

export function isPagesRscFallbackOutput(output: NormalizedOutput): boolean {
  return output.kind === "static"
    && typeof output.filePath === "string"
    && output.pathname.endsWith(".rsc")
    && path.basename(output.filePath) === "rsc-fallback.json";
}

export function pagesStaticDataPathname(
  model: NextBuildModel,
  output: NormalizedOutput,
): string | null {
  if (!isPagesStaticHtmlOutput(output)) return null;
  const routePath = publicRoutePath(model, output);
  const rel = routePath === "/" ? "index" : routePath.replace(/^\//, "");
  return `${basePath(model.config)}/_next/data/${model.buildId}/${rel}.json`;
}

export function pagesStaticDataJson(): string {
  return JSON.stringify({ pageProps: {} });
}
