export interface BrrrdManifest {
  schemaVersion: 4;
  build: BrrrdBuildInfo;
  /** Kept as a top-level convenience for artifact stores and fleet pointers. */
  buildId: string;
  appBundle?: string;
  routes: BrrrdRoute[];
  staticDir: string;
  prerendersDir: string;
  runtimeDir: string;
  env: Record<string, string>;
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
  nextVersion: string;
  adapterVersion?: string;
  createdAt: string;
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
  headers: BrrrdHeaderRule[];
  redirects: BrrrdRedirect[];
  proxy: BrrrdProxySpec | null;
  rewrites: BrrrdRewritePhases;
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
  /** Next webpack edge runtime 의 절대 경로 (manifest outDir 기준 상대). */
  runtime: string;
  /** Next 가 생성한 proxy/middleware webpack chunk 의 상대 경로. */
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
  has?: BrrrdMiddlewareCondition[];
  missing?: BrrrdMiddlewareCondition[];
  internal?: boolean;
}

export interface BrrrdRewrite {
  regex: string;
  source: string;
  destination: string;
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

export interface BrrrdRoute {
  id: string;
  pattern: string;
  type: "page" | "route" | "static" | "prerender";
  runtime: "nodejs";
  bundle?: string;
  file?: string;
  params?: string[];
  immutable?: boolean;
}

export interface BuildContext {
  projectDir: string;
  distDir: string;
  outDir: string;
  buildId: string;
}
