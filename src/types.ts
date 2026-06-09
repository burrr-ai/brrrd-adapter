export interface BrrrdManifest {
  version: 1 | 2;
  buildId: string;
  appBundle?: string;
  routes: BrrrdRoute[];
  staticDir: string;
  prerendersDir: string;
  runtimeDir: string;
  env: Record<string, string>;
  redirects?: BrrrdRedirect[];
  rewrites?: BrrrdRewrite[];
  /** A-1: middleware.ts 가 존재할 때 bundle 경로 + matcher 패턴. */
  middleware?: BrrrdMiddleware;
  /** A-7: Partial Prerendering 활성 페이지 목록. 빈 배열이면 PPR 미사용. */
  pprPages?: string[];
}

export interface BrrrdMiddleware {
  /** Next webpack edge runtime 의 절대 경로 (manifest outDir 기준 상대). */
  runtime: string;
  /** Next 가 생성한 middleware.js (webpack chunk) 의 상대 경로. */
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

  /** @deprecated 호환용 (구 manifest reader). 항상 빈 배열. */
  bundle?: string;
}

export interface BrrrdMiddlewareMatcher {
  regexp: string;
  originalSource: string;
  has?: BrrrdMiddlewareCondition[];
  missing?: BrrrdMiddlewareCondition[];
}

export interface BrrrdMiddlewareCondition {
  type: "header" | "cookie" | "query" | "host";
  key: string;
  value?: string;
}

export interface BrrrdMiddlewareFile {
  name?: string;
  filePath: string;
}

export interface BrrrdRedirect {
  regex: string;
  destination: string;
  statusCode: number;
}

export interface BrrrdRewrite {
  regex: string;
  destination: string;
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
