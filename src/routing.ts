/** Sanitize output ID for use as filename — replace slashes and brackets. */
export function sanitizeId(id: string): string {
  let s = id
    .replace(/^\//, "")
    .replace(/\//g, "-")
    .replace(/\[/g, "_")
    .replace(/\]/g, "_")
    .replace(/\./g, "_")
    .replace(/:/g, "_");
  if (s === "") s = "index";
  return s;
}

/**
 * Returns the on-disk file path for a prerender pathname, accounting for
 * collisions where a parent prerender (`/posts`) would shadow a directory
 * needed by nested prerenders (`/posts/1`). Such parent paths are stored as
 * `/posts/index` instead so the filesystem layout is consistent.
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
