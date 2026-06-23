export function basePath(config: unknown): string {
  if (!config || typeof config !== "object") return "";
  const value = (config as { basePath?: unknown }).basePath;
  if (typeof value !== "string" || value.length === 0 || value === "/") return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function defaultLocale(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const i18n = (config as { i18n?: unknown }).i18n;
  if (!i18n || typeof i18n !== "object") return null;
  const value = (i18n as { defaultLocale?: unknown }).defaultLocale;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function locales(config: unknown): string[] {
  if (!config || typeof config !== "object") return [];
  const i18n = (config as { i18n?: unknown }).i18n;
  if (!i18n || typeof i18n !== "object") return [];
  const value = (i18n as { locales?: unknown }).locales;
  if (!Array.isArray(value)) return [];
  return value.filter((locale): locale is string => typeof locale === "string" && locale.length > 0);
}

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function pprEnabled(experimental: Record<string, unknown>): boolean {
  const value = experimental.ppr;
  if (typeof value === "boolean") return value;
  return value === "incremental";
}

function jsonLiteral(value: unknown): string {
  return JSON.stringify(value ?? false);
}

function runtimeEnvValue(value: unknown): string {
  if (value === true) return "true";
  if (value === false || value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function jsonObjectValue(value: unknown): JsonLike {
  return value && typeof value === "object" ? value as JsonLike : {};
}

function nextServerBuildEnv(config: unknown): Record<string, JsonLike> {
  const root = objectValue(config);
  const experimental = objectValue(root.experimental);
  const cacheComponents = booleanValue(root.cacheComponents);
  return {
    NODE_ENV: "production",
    NEXT_RUNTIME: "nodejs",
    __NEXT_BUNDLER: "Webpack",
    __NEXT_DEV_SERVER: "",
    NEXT_MINIMAL: "",
    __NEXT_APP_NAV_FAIL_HANDLING: booleanValue(experimental.appNavFailHandling),
    __NEXT_APP_NEW_SCROLL_HANDLER: booleanValue(experimental.appNewScrollHandler),
    __NEXT_PPR: pprEnabled(experimental),
    __NEXT_CACHE_COMPONENTS: cacheComponents,
    __NEXT_EXPERIMENTAL_CACHED_NAVIGATIONS: booleanValue(experimental.cachedNavigations),
    __NEXT_INSTANT_NAV_TOGGLE: cacheComponents,
    __NEXT_USE_CACHE: booleanValue(experimental.useCache),
    __NEXT_USE_NODE_STREAMS: true,
    NEXT_SUPPORTS_IMMUTABLE_ASSETS: booleanValue(experimental.supportsImmutableAssets),
    __NEXT_BUNDLER_HAS_PERSISTENT_CACHE: true,
    __NEXT_REACT_DEBUG_CHANNEL: booleanValue(experimental.reactDebugChannel),
    __NEXT_TRANSITION_INDICATOR: booleanValue(experimental.transitionIndicator),
    __NEXT_GESTURE_TRANSITION: booleanValue(experimental.gestureTransition),
    __NEXT_OPTIMISTIC_ROUTING: booleanValue(experimental.optimisticRouting),
    __NEXT_INSTRUMENTATION_CLIENT_ROUTER_TRANSITION_EVENTS: booleanValue(
      experimental.instrumentationClientRouterTransitionEvents,
    ),
    __NEXT_APP_SHELLS: booleanValue(experimental.appShells),
    __NEXT_VARY_PARAMS: booleanValue(experimental.varyParams),
    __NEXT_EXPOSE_TESTING_API: booleanValue(experimental.exposeTestingApiInProductionBuild),
    __NEXT_CACHE_LIFE: jsonObjectValue(root.cacheLife),
    __NEXT_CLIENT_PARAM_PARSING_ORIGINS: Array.isArray(experimental.clientParamParsingOrigins)
      ? experimental.clientParamParsingOrigins.filter((origin): origin is string => typeof origin === "string")
      : [],
  };
}

export function nextServerDefineEnv(config: unknown): Record<string, string> {
  const env = nextServerBuildEnv(config);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[`process.env.${key}`] = jsonLiteral(value);
  }
  return out;
}

export function nextServerRuntimeEnv(config: unknown): Record<string, string> {
  const env = nextServerBuildEnv(config);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = runtimeEnvValue(value);
  }
  return out;
}
