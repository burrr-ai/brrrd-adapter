import type { BrrrdRoute } from "./types.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sanitize output ID for use as filename — replace slashes and brackets. */
function sanitizeId(id: string): string {
  let s = id
    .replace(/^\//, "")
    .replace(/\//g, "-")
    .replace(/\[/g, "_")
    .replace(/\]/g, "_")
    .replace(/\./g, "_");
  // Root path "/" becomes empty after stripping — use "index"
  if (s === "") s = "index";
  return s;
}

/**
 * Convert Next.js dynamic route pattern to regex.
 * /posts/[id]         -> { regex: '^/posts/([^/]+)$', params: ['id'] }
 * /docs/[...slug]     -> { regex: '^/docs/(.+)$', params: ['slug'] }
 * /docs/[[...slug]]   -> { regex: '^/docs(?:/(.+))?$', params: ['slug'] }
 */
function nextPatternToRegex(pathname: string): {
  regex: string;
  params: string[];
} {
  const params: string[] = [];
  const regex = pathname
    // optional catch-all: [[...param]]
    .replace(/\/?\[\[\.\.\.(\w+)\]\]/g, (_, name: string) => {
      params.push(name);
      return "(?:/(.+))?";
    })
    // catch-all: [...param]
    .replace(/\[\.\.\.(\w+)\]/g, (_, name: string) => {
      params.push(name);
      return "(.+)";
    })
    // dynamic segment: [param]
    .replace(/\[(\w+)\]/g, (_, name: string) => {
      params.push(name);
      return "([^/]+)";
    });
  return { regex: `^${regex}$`, params };
}

export { sanitizeId };

/**
 * Returns the on-disk file path for a prerender pathname, accounting for
 * collisions where a parent prerender (`/posts`) would shadow a directory
 * needed by nested prerenders (`/posts/1`). Such parent paths are stored as
 * `/posts/index` instead so the filesystem layout is consistent.
 *
 * Both build.ts (copying prerender HTML) and convertRoutes (manifest `file`)
 * must agree on the rewrite — otherwise handle_static lookups miss.
 */
export function prerenderStaticFile(
  pathname: string,
  allPrerenderPaths: readonly string[],
): string {
  if (pathname === "/") return pathname;
  const prefix = pathname + "/";
  const hasChild = allPrerenderPaths.some(
    (p) => p !== pathname && p.startsWith(prefix),
  );
  return hasChild ? `${pathname}/index` : pathname;
}

/**
 * Collect prerender pathnames that participate in parent/child collision
 * detection. Skip RSC / segment variants, but keep dynamic templates: even
 * though `/posts/[id]` is not itself written to disk, it signals that the
 * static `/posts` parent must live inside a directory so nested writes don't
 * trip ENOTDIR/EEXIST when filesystem layout is materialised.
 */
export function listPrerenderPathnames(
  prerenders: ReadonlyArray<{ pathname: string }>,
): string[] {
  const out: string[] = [];
  for (const pr of prerenders) {
    if (pr.pathname.includes(".rsc") || pr.pathname.includes(".segment")) {
      continue;
    }
    out.push(pr.pathname);
  }
  return out;
}

function handlerRoute(
  output: { id: string; pathname: string },
  type: "page" | "route",
): BrrrdRoute {
  const id = sanitizeId(output.id);
  if (!output.pathname.includes("[")) {
    return {
      id,
      pattern: `^${escapeRegex(output.pathname)}$`,
      type,
      runtime: "nodejs",
    };
  }
  const { regex, params } = nextPatternToRegex(output.pathname);
  return {
    id,
    pattern: regex,
    type,
    runtime: "nodejs",
    params,
  };
}

export function convertRoutes(ctx: {
  outputs: {
    staticFiles: Array<{
      id: string;
      pathname: string;
      immutableHash?: string;
    }>;
    prerenders: Array<{
      id: string;
      pathname: string;
      fallback?: { filePath: string };
    }>;
    appPages: Array<{
      id: string;
      pathname: string;
      runtime?: string;
    }>;
    appRoutes: Array<{
      id: string;
      pathname: string;
      runtime?: string;
    }>;
    pages: Array<{
      id: string;
      pathname: string;
      runtime?: string;
    }>;
    pagesApi: Array<{
      id: string;
      pathname: string;
      runtime?: string;
    }>;
  };
}): BrrrdRoute[] {
  const routes: BrrrdRoute[] = [];

  // 1. _next/static catch-all (highest priority)
  routes.push({
    id: "_next_static",
    pattern: "^/_next/static/(.+)$",
    type: "static",
    runtime: "nodejs",
    bundle: "",
    file: "/_next/static/",
    immutable: true,
    params: ["path"],
  });

  // 2. Other static files (public/*, 404, 500)
  for (const file of ctx.outputs.staticFiles) {
    if (file.pathname.startsWith("/_next/static/")) continue;
    routes.push({
      id: `static-${sanitizeId(file.pathname)}`,
      pattern: `^${escapeRegex(file.pathname)}$`,
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: file.pathname,
      immutable: !!file.immutableHash,
    });
  }

  // 3. Prerender routes (static HTML)
  // Skip prerenders that also have a page handler — the handler can serve
  // both GET (prerendered HTML) and POST (Server Actions). If a prerender
  // route shadows the handler, POST requests would incorrectly return HTML.
  const allPages = [...ctx.outputs.appPages, ...ctx.outputs.pages];
  const handledPaths = new Set(allPages.map((p) => p.pathname));
  const prerenderPaths = listPrerenderPathnames(ctx.outputs.prerenders);
  for (const pr of ctx.outputs.prerenders) {
    if (pr.pathname.includes("[") || pr.pathname.includes(".rsc") || pr.pathname.includes(".segment")) continue;
    if (handledPaths.has(pr.pathname)) continue;
    routes.push({
      id: `prerender-${sanitizeId(pr.pathname)}`,
      pattern: `^${escapeRegex(pr.pathname)}$`,
      type: "prerender" as const,
      runtime: "nodejs",
      bundle: "",
      file: prerenderStaticFile(pr.pathname, prerenderPaths),
    });
  }

  // 4. All page handlers (exact match first, dynamic later)
  const exactPages = allPages.filter((p) => !p.pathname.includes("["));
  const dynamicPages = allPages.filter((p) => p.pathname.includes("["));

  for (const page of exactPages) {
    routes.push(handlerRoute(page, "page"));
  }

  for (const page of dynamicPages) {
    routes.push(handlerRoute(page, "page"));
  }

  // 4. App Routes (API endpoints)
  for (const route of ctx.outputs.appRoutes) {
    routes.push(handlerRoute(route, "route"));
  }

  // 5. Pages Router API routes
  for (const api of ctx.outputs.pagesApi) {
    routes.push(handlerRoute(api, "route"));
  }

  return routes;
}
