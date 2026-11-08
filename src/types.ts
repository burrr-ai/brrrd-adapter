export interface BrrrdManifest {
  schemaVersion: 6;
  execution: { abi: "workerd-node-v1" };
  build: BrrrdBuildInfo;
  /** Kept as a top-level convenience for artifact stores and fleet pointers. */
  buildId: string;
  appBundle?: string;
  routes: BrrrdRoute[];
  staticDir: string;
  prerendersDir: string;
  runtimeDir: string;
  env: Record<string, string>;
  images: BrrrdImagesConfig;
  /** Next preview/draft-mode cookie metadata from prerender-manifest.json. */
  preview?: BrrrdPreviewConfig;
  artifacts: BrrrdArtifact[];
  compatibility: BrrrdCompatibilityReport;
  routing: BrrrdRouting;
  /** Next proxy/middleware phase bundle path + matcher metadata. */
  middleware?: BrrrdMiddleware;
  /** A-7: Partial Prerendering 활성 페이지 목록. 빈 배열이면 PPR 미사용. */
  pprPages?: string[];
}

export interface BrrrdBuildInfo {
  buildId: string;
  deploymentId?: string;
  nextVersion: string;
  adapterVersion?: string;
  createdAt: string;
}

export interface BrrrdImagesConfig {
  deviceSizes: number[];
  imageSizes: number[];
  domains: string[];
  remotePatterns: BrrrdRemoteImagePattern[];
  localPatterns?: BrrrdLocalImagePattern[];
  qualities?: number[];
  minimumCacheTTL: number;
}

export interface BrrrdPreviewConfig {
  previewModeId: string;
  previewModeSigningKey?: string;
  previewModeEncryptionKey?: string;
}

export interface BrrrdRemoteImagePattern {
  protocol?: string;
  hostname: string;
  port?: string;
  pathname?: string;
  search?: string;
}

export interface BrrrdLocalImagePattern {
  pathname?: string;
  search?: string;
}

export interface BrrrdArtifact {
  id: string;
  kind:
    | "app-bundle"
    | "static"
    | "public"
    | "prerender"
    | "runtime-manifest"
    | "runtime-file"
    | "middleware"
    | "compatibility";
  ownerRouteId?: string;
  sourcePath?: string;
  packagePath: string;
  mountPath: string;
  contentType?: string;
  immutable?: boolean;
  required: boolean;
  reason: string;
}

export interface BrrrdCompatibilityReport {
  policies: BrrrdCompatibilityPolicy[];
}

export interface BrrrdCompatibilityPolicy {
  name: string;
  action: "applied" | "validated" | "rejected";
  detail?: string;
}

export interface BrrrdRouting {
  basePath?: string;
  trailingSlash?: true;
  i18n?: BrrrdRoutingI18n;
  headers: BrrrdHeaderRule[];
  redirects: BrrrdRedirect[];
  proxy: BrrrdProxySpec | null;
  rewrites: BrrrdRewritePhases;
}

export interface BrrrdRoutingI18n {
  locales: string[];
  defaultLocale: string;
  basePath?: string;
  localeDetection?: false;
}

export interface BrrrdRewritePhases {
  beforeFiles: BrrrdRewrite[];
  afterFiles: BrrrdRewrite[];
  fallback: BrrrdRewrite[];
}

export interface BrrrdProxySpec {
  source: "middleware" | "proxy";
}

export interface BrrrdMiddleware {
  /** How the copied Next proxy/middleware chunks should be loaded by the runtime bridge. */
  moduleFormat: "node";
  /** Next proxy/middleware chunk files, in manifest evaluation order. */
  files: string[];
  /** Legacy single runtime chunk path retained for diagnostics and older webpack-shaped output. */
  runtime: string;
  /** Next proxy/middleware entry chunk. */
  entry: string;
  /** Next 의 _ENTRIES key suffix (보통 "middleware"). */
  name: string;
  /** middleware 의 "page" (보통 "/middleware" 또는 "/proxy"). */
  page: string;
  /** Next matcher 명세 (regexp 는 그대로 Rust regex 로 컴파일됨). */
  matchers: BrrrdMiddlewareMatcher[];
  /** middleware-manifest.wasm — copied raw next to runtime files. */
  wasm: BrrrdMiddlewareFile[];
  /** middleware-manifest.assets — copied raw next to runtime files. */
  assets: BrrrdMiddlewareFile[];
  /** middleware-manifest.env — process.env 에 머지될 build-time 상수. */
  env: Record<string, string>;
}

export interface BrrrdMiddlewareMatcher {
  regexp: string;
  originalSource: string;
  locale?: false;
  has?: BrrrdMiddlewareCondition[];
  missing?: BrrrdMiddlewareCondition[];
}

export interface BrrrdMiddlewareCondition {
  type: "header" | "cookie" | "query" | "host";
  key?: string;
  value?: string;
}

export interface BrrrdMiddlewareFile {
  name?: string;
  filePath: string;
}

export interface BrrrdRedirect {
  regex: string;
  source: string;
  destination: string;
  statusCode: number;
  locale?: false;
  has?: BrrrdMiddlewareCondition[];
  missing?: BrrrdMiddlewareCondition[];
  internal?: boolean;
}

export interface BrrrdRewrite {
  regex: string;
  source: string;
  destination: string;
  locale?: false;
  has?: BrrrdMiddlewareCondition[];
  missing?: BrrrdMiddlewareCondition[];
  internal?: boolean;
}

export interface BrrrdHeaderRule {
  regex: string;
  source: string;
  headers: Array<{ key: string; value: string }>;
  has?: BrrrdMiddlewareCondition[];
  missing?: BrrrdMiddlewareCondition[];
  internal?: boolean;
}

export interface BrrrdHeaderPair {
  key: string;
  value: string;
}

export interface BrrrdFallbackRouteParam {
  paramName: string;
  paramType: string;
}

export interface BrrrdRoute {
  id: string;
  pattern: string;
  type: "page" | "route" | "static" | "prerender" | "image-optimizer";
  runtime: "nodejs";
  bundle?: string;
  /** Static store key or Next static lookup template for captured filesystem routes. */
  file?: string;
  params?: string[];
  paramTypes?: Record<string, "single" | "catchAll" | "optionalCatchAll">;
  localeHandling?: "unprefixed";
  immutable?: boolean;
  /** PPR app-page document requests must go through the Next handler so it can resume/inject client bootstrap. */
  ppr?: boolean;
  /** PPR RSC resume metadata from the Next Adapter API prerender output. */
  pprResume?: {
    headers: Record<string, string>;
    postponedState: string;
  };
  /**
   * Next prerender-manifest dynamic route fallback params. App Shell runtime
   * prefetches use these to defer unresolved dynamic params without replacing
   * concrete route params in the public URL.
   */
  pprFallbackRouteParams?: BrrrdFallbackRouteParam[];
  /** Route was generated from a Next intercepting route segment such as (.) or (...). */
  intercepted?: boolean;
  /** Next preview/draft requests may activate this fallback:false dynamic SSG handler. */
  previewOnly?: boolean;
  /** Next dynamicParams=false/fallback=false route: regular requests may only hit concrete prerenders. */
  staticPathsOnly?: boolean;
  /** Request conditions that may bypass staticPathsOnly and invoke the dynamic handler. */
  prerenderBypass?: BrrrdMiddlewareCondition[];
  /** Pages Router fallback:true shell; crawler requests must skip it and block on the handler. */
  pagesFallbackShell?: boolean;
  /** Adapter API PRERENDER config: only these user query keys may use this filesystem route. */
  allowQuery?: string[];
  /** Adapter API PRERENDER ISR metadata used by the runtime to decide static vs handler serving. */
  isr?: {
    initialRevalidate: number | false;
    initialExpire?: number;
    generatedAtMs: number;
    bypassToken?: string;
    allowHeader?: string[];
  };
  /** This handler response represents a deploy prerender data fallback and uses Next deploy cache policy. */
  deployPrerenderCacheControl?: boolean;
  status?: number;
  headers?: BrrrdHeaderPair[];
}

export interface BuildContext {
  projectDir: string;
  distDir: string;
  outDir: string;
  buildId: string;
  config?: unknown;
}
