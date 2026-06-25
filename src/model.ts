import * as fs from "node:fs";
import * as path from "node:path";

import { basePath } from "./next-config.js";

type RawAdapterOutput = {
  id: string;
  pathname: string;
  type?: string;
  runtime?: string;
  filePath?: string;
  sourcePage?: string;
  assets?: Record<string, string>;
  wasmAssets?: Record<string, string>;
  edgeRuntime?: {
    modulePath: string;
    entryKey: string;
    handlerExport: string;
  };
  config?: Record<string, unknown>;
  immutableHash?: string;
  fallback?: {
    filePath?: string;
    initialStatus?: number;
    initialHeaders?: Record<string, string | string[]>;
    initialRevalidate?: number | false;
    initialExpiration?: number;
    postponedState?: string;
  };
  parentOutputId?: string;
  groupId?: number;
  pprChain?: { headers: Record<string, string> };
  parentFallbackMode?: unknown;
};

export type AdapterRouteEntry = {
  source?: string;
  sourceRegex: string;
  destination?: string;
  headers?: Record<string, string>;
  has?: AdapterRouteCondition[];
  missing?: AdapterRouteCondition[];
  status?: number;
  priority?: boolean;
  internal?: boolean;
};

export type AdapterRouteCondition = {
  type: "header" | "cookie" | "query" | "host";
  key?: string;
  value?: string;
};

export type AdapterBuildContext = {
  routing?: Partial<{
    beforeMiddleware: AdapterRouteEntry[];
    beforeFiles: AdapterRouteEntry[];
    afterFiles: AdapterRouteEntry[];
    dynamicRoutes: AdapterRouteEntry[];
    onMatch: AdapterRouteEntry[];
    fallback: AdapterRouteEntry[];
    shouldNormalizeNextData: boolean;
    rsc: unknown;
  }>;
  outputs: {
    pages: RawAdapterOutput[];
    appPages: RawAdapterOutput[];
    appRoutes: RawAdapterOutput[];
    pagesApi: RawAdapterOutput[];
    middleware?: RawAdapterOutput;
    prerenders: RawAdapterOutput[];
    staticFiles: RawAdapterOutput[];
  };
  projectDir: string;
  repoRoot: string;
  distDir: string;
  config: unknown;
  nextVersion: string;
  buildId: string;
};

export type NormalizedOutputKind =
  | "page"
  | "app-page"
  | "app-route"
  | "pages-api"
  | "prerender"
  | "static"
  | "public"
  | "middleware";

export type NormalizedOutput = {
  id: string;
  pathname: string;
  kind: NormalizedOutputKind;
  runtime?: string;
  filePath?: string;
  sourcePage?: string;
  routeKind: "page" | "route" | "static" | "prerender" | "middleware";
  appPath?: string;
  urlPath: string;
  pagesRoutePath?: string;
  assets: Record<string, string>;
  wasmAssets: Record<string, string>;
  edgeRuntime?: RawAdapterOutput["edgeRuntime"];
  config: Record<string, unknown>;
  immutableHash?: string;
  fallback?: RawAdapterOutput["fallback"];
  parentOutputId?: string;
  groupId?: number;
  pprChain?: { headers: Record<string, string> };
  parentFallbackMode?: unknown;
};

export type NormalizedRouting = {
  beforeMiddleware: AdapterRouteEntry[];
  beforeFiles: AdapterRouteEntry[];
  afterFiles: AdapterRouteEntry[];
  dynamicRoutes: AdapterRouteEntry[];
  onMatch: AdapterRouteEntry[];
  fallback: AdapterRouteEntry[];
  shouldNormalizeNextData: boolean;
  rsc: unknown;
};

export type NextBuildModel = {
  projectDir: string;
  repoRoot: string;
  distDir: string;
  config: unknown;
  nextVersion: string;
  buildId: string;
  routing: NormalizedRouting;
  outputs: {
    pages: NormalizedOutput[];
    appPages: NormalizedOutput[];
    appRoutes: NormalizedOutput[];
    pagesApi: NormalizedOutput[];
    middleware?: NormalizedOutput;
    prerenders: NormalizedOutput[];
    staticFiles: NormalizedOutput[];
  };
};

function isInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function normalizeIndexUrlPath(pathname: string): string {
  if (pathname === "/index") return "/";
  if (pathname.endsWith("/index")) return pathname.slice(0, -"/index".length) || "/";
  return pathname;
}

function withoutBasePath(pathname: string, config: unknown): string {
  const configured = basePath(config);
  if (!configured) return pathname;
  if (pathname === configured) return "/";
  const prefix = `${configured}/`;
  return pathname.startsWith(prefix) ? `/${pathname.slice(prefix.length)}` : pathname;
}

function withBasePath(pathname: string, config: unknown): string {
  const configured = basePath(config);
  if (!configured) return pathname;
  return pathname === "/" ? configured : `${configured}${pathname}`;
}

function pagesFileRoutePath(
  raw: RawAdapterOutput,
  pagesDir: string,
  config: unknown,
): string | null {
  if (!raw.filePath) return null;
  const relative = path.relative(pagesDir, raw.filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const routePath = "/" + relative
    .split(path.sep)
    .join("/")
    .replace(/\.[^/.]+$/, "");
  if (routePath === withoutBasePath(raw.pathname, config)) return routePath;
  if (raw.pathname.startsWith("/_next/data/") && routePath.includes("[")) {
    return routePath;
  }
  return null;
}

function outputUrlPath(
  raw: RawAdapterOutput,
  kind: NormalizedOutputKind,
  options: { distDir?: string; config?: unknown } = {},
  pagesRoutePath?: string | null,
): string {
  const { distDir, config } = options;
  if (!raw.filePath || !distDir) return raw.pathname;
  const ext = path.extname(raw.filePath).toLowerCase();
  if (
    kind === "static"
    && ext === ".html"
    && pagesRoutePath
  ) {
    return withBasePath(normalizeIndexUrlPath(pagesRoutePath), config);
  }
  if (
    kind === "page"
    && !raw.pathname.startsWith("/_next/data/")
    && pagesRoutePath
  ) {
    return withBasePath(normalizeIndexUrlPath(pagesRoutePath), config);
  }
  return raw.pathname;
}

function normalizeOutput(
  raw: RawAdapterOutput,
  kind: NormalizedOutputKind,
  options: { distDir?: string; config?: unknown } = {},
): NormalizedOutput {
  const pagesDir = options.distDir
    ? path.join(options.distDir, "server", "pages")
    : undefined;
  const pagesRoutePath = pagesDir
    ? pagesFileRoutePath(raw, pagesDir, options.config)
    : null;
  const routeKind = kind === "app-route" || kind === "pages-api"
    ? "route"
    : kind === "static" || kind === "public"
      ? "static"
      : kind === "prerender"
        ? "prerender"
        : kind === "middleware"
          ? "middleware"
          : "page";
  return {
    id: raw.id,
    pathname: raw.pathname,
    kind,
    runtime: raw.runtime,
    filePath: raw.filePath,
    sourcePage: raw.sourcePage,
    routeKind,
    appPath: raw.sourcePage,
    urlPath: outputUrlPath(raw, kind, options, pagesRoutePath),
    ...(pagesRoutePath ? { pagesRoutePath } : {}),
    assets: raw.assets ?? {},
    wasmAssets: raw.wasmAssets ?? {},
    edgeRuntime: raw.edgeRuntime,
    config: raw.config ?? {},
    immutableHash: raw.immutableHash,
    fallback: raw.fallback,
    parentOutputId: raw.parentOutputId,
    groupId: raw.groupId,
    pprChain: raw.pprChain,
    parentFallbackMode: raw.parentFallbackMode,
  };
}

function isPagesApiRoutePath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isPagesApiFile(raw: RawAdapterOutput, distDir: string): boolean {
  if (!raw.filePath) return false;
  const pagesDir = path.join(distDir, "server", "pages");
  const relative = path.relative(pagesDir, raw.filePath).split(path.sep).join("/");
  return relative === "api.js" || relative.startsWith("api/");
}

function isPagesApiOutput(raw: RawAdapterOutput, distDir: string): boolean {
  return isPagesApiRoutePath(raw.pathname) || isPagesApiFile(raw, distDir);
}

function normalizeRouteArray(value: unknown): AdapterRouteEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is AdapterRouteEntry => (
    entry
    && typeof entry === "object"
    && typeof (entry as { sourceRegex?: unknown }).sourceRegex === "string"
  ));
}

function normalizeRouting(routing: AdapterBuildContext["routing"]): NormalizedRouting {
  return {
    beforeMiddleware: normalizeRouteArray(routing?.beforeMiddleware),
    beforeFiles: normalizeRouteArray(routing?.beforeFiles),
    afterFiles: normalizeRouteArray(routing?.afterFiles),
    dynamicRoutes: normalizeRouteArray(routing?.dynamicRoutes),
    onMatch: normalizeRouteArray(routing?.onMatch),
    fallback: normalizeRouteArray(routing?.fallback),
    shouldNormalizeNextData: routing?.shouldNormalizeNextData === true,
    rsc: routing?.rsc,
  };
}

function collectPublicOutputs(projectDir: string): NormalizedOutput[] {
  const publicDir = path.join(projectDir, "public");
  if (!fs.existsSync(publicDir) || !fs.statSync(publicDir).isDirectory()) return [];
  const collected: NormalizedOutput[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(publicDir, abs).split(path.sep).join("/");
      const pathname = "/" + rel;
      collected.push(normalizeOutput({
        id: `public:${pathname}`,
        pathname,
        filePath: abs,
      }, "public"));
    }
  };
  walk(publicDir);
  return collected;
}

function mergePublicStaticFiles(ctx: AdapterBuildContext): NormalizedOutput[] {
  const staticFiles = ctx.outputs.staticFiles.map((output) => (
    normalizeOutput(output, "static", { distDir: ctx.distDir, config: ctx.config })
  ));
  const takenPaths = new Set<string>([
    ...staticFiles.map((output) => output.pathname),
    ...ctx.outputs.pages.map((output) => output.pathname),
    ...ctx.outputs.appPages.map((output) => output.pathname),
    ...ctx.outputs.appRoutes.map((output) => output.pathname),
    ...ctx.outputs.pagesApi.map((output) => output.pathname),
  ]);
  for (const publicOutput of collectPublicOutputs(ctx.projectDir)) {
    if (takenPaths.has(publicOutput.pathname)) continue;
    takenPaths.add(publicOutput.pathname);
    staticFiles.push(publicOutput);
  }
  return staticFiles;
}

export function createNextBuildModel(ctx: AdapterBuildContext): NextBuildModel {
  const pageOutputs = [
    ...ctx.outputs.pages,
    ...ctx.outputs.pagesApi.filter((output) => !isPagesApiOutput(output, ctx.distDir)),
  ];
  const pagesApiOutputs = ctx.outputs.pagesApi
    .filter((output) => isPagesApiOutput(output, ctx.distDir));

  return {
    projectDir: ctx.projectDir,
    repoRoot: ctx.repoRoot,
    distDir: ctx.distDir,
    config: ctx.config,
    nextVersion: ctx.nextVersion,
    buildId: ctx.buildId,
    routing: normalizeRouting(ctx.routing),
    outputs: {
      pages: pageOutputs.map((output) => normalizeOutput(output, "page", {
        distDir: ctx.distDir,
        config: ctx.config,
      })),
      appPages: ctx.outputs.appPages.map((output) => normalizeOutput(output, "app-page")),
      appRoutes: ctx.outputs.appRoutes.map((output) => normalizeOutput(output, "app-route")),
      pagesApi: pagesApiOutputs.map((output) => normalizeOutput(output, "pages-api")),
      middleware: ctx.outputs.middleware
        ? normalizeOutput(ctx.outputs.middleware, "middleware")
        : undefined,
      prerenders: ctx.outputs.prerenders.map((output) => normalizeOutput(output, "prerender")),
      staticFiles: mergePublicStaticFiles(ctx),
    },
  };
}

export function requestOutputs(model: NextBuildModel): NormalizedOutput[] {
  return [
    ...model.outputs.appPages,
    ...model.outputs.appRoutes,
    ...model.outputs.pages,
    ...model.outputs.pagesApi,
  ];
}

export function allOutputs(model: NextBuildModel): NormalizedOutput[] {
  return [
    ...requestOutputs(model),
    ...model.outputs.prerenders,
    ...model.outputs.staticFiles,
    ...(model.outputs.middleware ? [model.outputs.middleware] : []),
  ];
}
