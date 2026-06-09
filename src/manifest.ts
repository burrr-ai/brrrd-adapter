import * as fs from "node:fs";
import * as path from "node:path";
import type {
  BrrrdManifest,
  BrrrdMiddleware,
  BrrrdMiddlewareCondition,
  BrrrdMiddlewareFile,
  BrrrdRedirect,
  BrrrdRewrite,
  BrrrdRoute,
} from "./types.js";

export function writeManifest(
  outDir: string,
  buildId: string,
  routes: BrrrdRoute[],
  env: Record<string, string>,
  redirects: BrrrdRedirect[] = [],
  rewrites: BrrrdRewrite[] = [],
  middleware?: BrrrdMiddleware,
  pprPages: string[] = [],
): void {
  const manifest: BrrrdManifest = {
    version: 2,
    buildId,
    appBundle: "bundles/app.js",
    routes,
    staticDir: "static",
    prerendersDir: "prerenders",
    runtimeDir: "runtime",
    env,
    redirects,
    rewrites,
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

function normalizeMiddlewareConditions(value: unknown): BrrrdMiddlewareCondition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: BrrrdMiddlewareCondition[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const type = item.type;
    const key = item.key;
    if (
      (type === "header" || type === "cookie" || type === "query" || type === "host") &&
      typeof key === "string" && key.length > 0
    ) {
      const cond: BrrrdMiddlewareCondition = { type, key };
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
 * A-1: middleware-manifest.json 에서 middleware 메타데이터 추출.
 * Next 가 middleware.ts 를 컴파일하면 `.next/server/middleware.js` (webpack chunk)
 * + `edge-runtime-webpack.js` (webpack runtime) 가 생성되고
 * `middleware-manifest.json` 에 entry 등록된다. 두 파일 모두 isolate 에 그대로
 * 평가되어 `_ENTRIES.middleware_<name>` 을 등록한다.
 */
export function extractMiddlewareMeta(distDir: string): {
  runtimeRel: string;          // 예: "server/edge-runtime-webpack.js"
  entryRel: string;            // 예: "server/middleware.js"
  name: string;                // 예: "middleware"
  page: string;                // 예: "/middleware"
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
  // Next 의 manifest 키는 mount path (보통 "/"). 첫 번째 entry 만 지원 (단일 root middleware).
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
  const entryRel = filesArr.find((f) => f.endsWith("middleware.js"))
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

// TD-4: routes-manifest.json 에서 정적 redirect / rewrite 규칙 추출.
// 사용자 정의 규칙만 포함 (Next 내부 trailing-slash redirect 등 `internal: true`
// 표시된 항목은 제외).
export function extractRoutingRules(distDir: string): {
  redirects: BrrrdRedirect[];
  rewrites: BrrrdRewrite[];
} {
  const manifestPath = path.join(distDir, "routes-manifest.json");
  const raw = readJsonIfExists(manifestPath);
  if (!raw) {
    return { redirects: [], rewrites: [] };
  }
  // rust `regex` 는 lookaround 미지원. Next 가 생성하는 `(?!/_next)` 같은
  // negative lookahead 를 strip — brrrd 의 라우팅 모델에서 `/_next/*` 는 별도
  // static catch-all 로 처리되므로 strip 해도 안전.
  const stripLookarounds = (re: string): string =>
    re.replace(/\(\?[!=][^)]*\)/g, "");

  const redirects: BrrrdRedirect[] = [];
  for (const r of raw.redirects ?? []) {
    if (r.internal) continue;
    if (!r.regex || !r.destination) continue;
    redirects.push({
      regex: stripLookarounds(r.regex),
      destination: r.destination,
      statusCode: typeof r.statusCode === "number"
        ? r.statusCode
        : (r.permanent ? 308 : 307),
    });
  }
  const rewrites: BrrrdRewrite[] = [];
  const rewriteSource = raw.rewrites;
  const collectRewrites = (arr: any[]) => {
    for (const w of arr ?? []) {
      if (!w.regex || !w.destination) continue;
      rewrites.push({ regex: stripLookarounds(w.regex), destination: w.destination });
    }
  };
  if (Array.isArray(rewriteSource)) {
    collectRewrites(rewriteSource);
  } else if (rewriteSource && typeof rewriteSource === "object") {
    if (Array.isArray(rewriteSource.beforeFiles) && rewriteSource.beforeFiles.length > 0) {
      throw new Error(
        "routes-manifest beforeFiles rewrites are not supported by brrrd adapter",
      );
    }
    collectRewrites(rewriteSource.afterFiles);
    collectRewrites(rewriteSource.fallback);
  }
  return { redirects, rewrites };
}
