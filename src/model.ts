import * as fs from "node:fs";
import * as path from "node:path";

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
  fallback?: { filePath?: string };
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
  assets: Record<string, string>;
  wasmAssets: Record<string, string>;
  edgeRuntime?: RawAdapterOutput["edgeRuntime"];
  config: Record<string, unknown>;
  immutableHash?: string;
  fallback?: { filePath?: string };
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

function normalizeIndexUrlPath(pathname: string): string {
  if (pathname === "/index") return "/";
  if (pathname.endsWith("/index")) return pathname.slice(0, -"/index".length) || "/";
  return pathname;
}

function outputMatchesPagesFile(raw: RawAdapterOutput, pagesDir: string): boolean {
  if (!raw.filePath) return false;
  const relative = path.relative(pagesDir, raw.filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const routePath = "/" + relative
    .split(path.sep)
    .join("/")
    .replace(/\.[^/.]+$/, "");
  return routePath === raw.pathname;
}

function outputUrlPath(
  raw: RawAdapterOutput,
  kind: NormalizedOutputKind,
  distDir?: string,
): string {
  if (!raw.filePath || !distDir) return raw.pathname;
  const pagesDir = path.join(distDir, "server", "pages");
  const ext = path.extname(raw.filePath).toLowerCase();
  if (
    kind === "static"
    && ext === ".html"
    && outputMatchesPagesFile(raw, pagesDir)
  ) {
    return normalizeIndexUrlPath(raw.pathname);
  }
  if (
    kind === "page"
    && !raw.pathname.startsWith("/_next/data/")
    && outputMatchesPagesFile(raw, pagesDir)
  ) {
    return normalizeIndexUrlPath(raw.pathname);
  }
  return raw.pathname;
}

function normalizeOutput(
  raw: RawAdapterOutput,
  kind: NormalizedOutputKind,
  options: { distDir?: string } = {},
): NormalizedOutput {
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
    urlPath: outputUrlPath(raw, kind, options.distDir),
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
    normalizeOutput(output, "static", { distDir: ctx.distDir })
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
  return {
    projectDir: ctx.projectDir,
    repoRoot: ctx.repoRoot,
    distDir: ctx.distDir,
    config: ctx.config,
    nextVersion: ctx.nextVersion,
    buildId: ctx.buildId,
    routing: normalizeRouting(ctx.routing),
    outputs: {
      pages: ctx.outputs.pages.map((output) => normalizeOutput(output, "page", { distDir: ctx.distDir })),
      appPages: ctx.outputs.appPages.map((output) => normalizeOutput(output, "app-page")),
      appRoutes: ctx.outputs.appRoutes.map((output) => normalizeOutput(output, "app-route")),
      pagesApi: ctx.outputs.pagesApi.map((output) => normalizeOutput(output, "pages-api")),
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
