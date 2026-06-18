import * as fs from "node:fs";
import * as path from "node:path";
import type {
  BrrrdHeaderRule,
  BrrrdManifest,
  BrrrdMiddleware,
  BrrrdMiddlewareCondition,
  BrrrdMiddlewareFile,
  BrrrdRedirect,
  BrrrdRouting,
  BrrrdRewrite,
  BrrrdRoute,
} from "./types.js";

export function emptyRouting(): BrrrdRouting {
  return {
    headers: [],
    redirects: [],
    proxy: null,
    rewrites: {
      beforeFiles: [],
      afterFiles: [],
      fallback: [],
    },
  };
}

export function writeManifest(
  outDir: string,
  buildId: string,
  routes: BrrrdRoute[],
  env: Record<string, string>,
  routing: BrrrdRouting = emptyRouting(),
  middleware?: BrrrdMiddleware,
  pprPages: string[] = [],
): void {
  const manifest: BrrrdManifest = {
    version: 3,
    buildId,
    appBundle: "bundles/app.js",
    routes,
    staticDir: "static",
    prerendersDir: "prerenders",
    runtimeDir: "runtime",
    env,
    routing,
    middleware,
    pprPages,
  };

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

function readJsonIfExists(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * A-7: PPR (Partial Prerendering) 활성 여부 + 해당 페이지 목록 추출.
 * Next 16.2 의 prerender-manifest.json 의 routes 엔트리에 `experimentalPPR`
 * 또는 `experimentalBypassFor` 가 있으면 PPR 페이지. routes-manifest.json 의
 * top-level `experimental.ppr` 도 globally enabled 여부 신호.
 */
export function extractPprPages(distDir: string): string[] {
  const path1 = path.join(distDir, "prerender-manifest.json");
  const raw = readJsonIfExists(path1);
  if (!raw) return [];
  const routes = raw?.routes ?? {};
  const pages: string[] = [];
  for (const [route, meta] of Object.entries(routes)) {
    const m = meta as any;
    if (m?.experimentalPPR === true || m?.renderingMode === "PARTIALLY_STATIC") {
      pages.push(route);
    }
  }
  return pages;
}

function normalizeConditions(value: unknown): BrrrdMiddlewareCondition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: BrrrdMiddlewareCondition[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const type = item.type;
    const key = item.key;
    if (type === "header" || type === "cookie" || type === "query" || type === "host") {
      if (type !== "host" && (typeof key !== "string" || key.length === 0)) continue;
      const cond: BrrrdMiddlewareCondition = { type };
      if (typeof key === "string" && key.length > 0) cond.key = key;
      if (typeof item.value === "string") cond.value = item.value;
      out.push(cond);
    }
  }
  return out.length > 0 ? out : undefined;
}

function normalizeMiddlewareFiles(value: unknown): BrrrdMiddlewareFile[] {
  if (!Array.isArray(value)) return [];
  const out: BrrrdMiddlewareFile[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const filePath = item.filePath ?? item.file;
    if (typeof filePath !== "string" || filePath.length === 0) continue;
    out.push({
      filePath,
      ...(typeof item.name === "string" ? { name: item.name } : {}),
    });
  }
  return out;
}

/**
 * middleware-manifest.json 에서 proxy/middleware 메타데이터를 추출한다.
 * Next 가 생성한 edge runtime webpack chunk 는 esbuild 로 다시 묶지 않고
 * 그대로 isolate 에서 evaluate 한다.
 */
export function extractMiddlewareMeta(distDir: string): {
  runtimeRel: string;          // 예: "server/edge-runtime-webpack.js"
  entryRel: string;            // 예: "server/middleware.js" 또는 "server/proxy.js"
  name: string;                // 예: "middleware"
  page: string;                // 예: "/middleware" 또는 "/proxy"
  matchers: Array<{
    regexp: string;
    originalSource: string;
    has?: BrrrdMiddlewareCondition[];
    missing?: BrrrdMiddlewareCondition[];
  }>;
  wasm: BrrrdMiddlewareFile[];
  assets: BrrrdMiddlewareFile[];
  env: Record<string, string>;
} | null {
  const manifestPath = path.join(distDir, "server", "middleware-manifest.json");
  const raw = readJsonIfExists(manifestPath);
  if (!raw) return null;
  // Next 의 manifest 키는 mount path (보통 "/"). 단일 root proxy/middleware phase 만 지원.
  const middlewareMap = raw?.middleware ?? {};
  const mountKeys = Object.keys(middlewareMap);
  if (mountKeys.length > 1) {
    throw new Error(
      `multiple middleware entries are not supported by brrrd adapter: ${mountKeys.join(", ")}`,
    );
  }
  const mountKey = mountKeys[0];
  if (!mountKey) return null;
  const mw = middlewareMap[mountKey];
  if (!mw) return null;
  const filesArr: string[] = Array.isArray(mw.files) ? mw.files : [];
  const runtimeRel = filesArr.find((f) => f.includes("edge-runtime-webpack"))
    ?? "server/edge-runtime-webpack.js";
  const entryRel = typeof mw.entrypoint === "string" && mw.entrypoint.length > 0
    ? mw.entrypoint
    : filesArr.find((f) => f.endsWith("middleware.js") || f.endsWith("proxy.js"))
    ?? "server/middleware.js";
  if (!fs.existsSync(path.join(distDir, runtimeRel))) {
    throw new Error(`middleware runtime file missing: ${runtimeRel}`);
  }
  if (!fs.existsSync(path.join(distDir, entryRel))) {
    throw new Error(`middleware entry file missing: ${entryRel}`);
  }

  const matchersArr: Array<{
    regexp?: string;
    originalSource?: string;
    has?: unknown;
    missing?: unknown;
  }> = Array.isArray(mw.matchers)
    ? mw.matchers
    : [];
  const matchers = matchersArr
    .filter((m) => typeof m.regexp === "string")
    .map((m) => {
      const has = normalizeMiddlewareConditions(m.has);
      const missing = normalizeMiddlewareConditions(m.missing);
      return {
        regexp: m.regexp as string,
        originalSource: typeof m.originalSource === "string" ? m.originalSource : "",
        ...(has ? { has } : {}),
        ...(missing ? { missing } : {}),
      };
    });
  const envIn = mw.env && typeof mw.env === "object" ? mw.env : {};
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envIn)) {
    if (typeof v === "string") env[k] = v;
  }
  return {
    runtimeRel,
    entryRel,
    name: typeof mw.name === "string" ? mw.name : "middleware",
    page: typeof mw.page === "string" ? mw.page : "/middleware",
    matchers,
    wasm: normalizeMiddlewareFiles(mw.wasm),
    assets: normalizeMiddlewareFiles(mw.assets),
    env,
  };
}

const normalizeMiddlewareConditions = normalizeConditions;

// routes-manifest.json 에서 Next routing metadata 를 phase 보존 형태로 추출한다.
export function extractRoutingManifest(distDir: string): BrrrdRouting {
  const manifestPath = path.join(distDir, "routes-manifest.json");
  const raw = readJsonIfExists(manifestPath);
  if (!raw) {
    return emptyRouting();
  }
  const headers: BrrrdHeaderRule[] = [];
  for (const h of raw.headers ?? []) {
    if (!h.regex || !Array.isArray(h.headers)) continue;
    const headerPairs = h.headers
      .filter((item: any) => typeof item?.key === "string" && typeof item?.value === "string")
      .map((item: any) => ({ key: item.key, value: item.value }));
    if (headerPairs.length === 0) continue;
    const has = normalizeConditions(h.has);
    const missing = normalizeConditions(h.missing);
    headers.push({
      regex: h.regex,
      source: typeof h.source === "string" ? h.source : "",
      headers: headerPairs,
      ...(has ? { has } : {}),
      ...(missing ? { missing } : {}),
      ...(h.internal === true ? { internal: true } : {}),
    });
  }

  const redirects: BrrrdRedirect[] = [];
  for (const r of raw.redirects ?? []) {
    if (r.internal) continue;
    if (!r.regex || !r.destination) continue;
    const has = normalizeConditions(r.has);
    const missing = normalizeConditions(r.missing);
    redirects.push({
      regex: r.regex,
      source: typeof r.source === "string" ? r.source : "",
      destination: r.destination,
      statusCode: typeof r.statusCode === "number"
        ? r.statusCode
        : (r.permanent ? 308 : 307),
      ...(has ? { has } : {}),
      ...(missing ? { missing } : {}),
      ...(r.internal === true ? { internal: true } : {}),
    });
  }
  const rewrites = emptyRouting().rewrites;
  const rewriteSource = raw.rewrites;
  const collectRewrites = (arr: any[], target: BrrrdRewrite[]) => {
    for (const w of arr ?? []) {
      if (!w.regex || !w.destination) continue;
      const has = normalizeConditions(w.has);
      const missing = normalizeConditions(w.missing);
      target.push({
        regex: w.regex,
        source: typeof w.source === "string" ? w.source : "",
        destination: w.destination,
        ...(has ? { has } : {}),
        ...(missing ? { missing } : {}),
        ...(w.internal === true ? { internal: true } : {}),
      });
    }
  };
  if (Array.isArray(rewriteSource)) {
    // Next applies array-form rewrites after filesystem/public checks and before
    // dynamic routes; represent that as afterFiles.
    collectRewrites(rewriteSource, rewrites.afterFiles);
  } else if (rewriteSource && typeof rewriteSource === "object") {
    collectRewrites(rewriteSource.beforeFiles, rewrites.beforeFiles);
    collectRewrites(rewriteSource.afterFiles, rewrites.afterFiles);
    collectRewrites(rewriteSource.fallback, rewrites.fallback);
  }
  return {
    headers,
    redirects,
    proxy: null,
    rewrites,
  };
}
