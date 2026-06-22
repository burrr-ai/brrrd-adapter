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
