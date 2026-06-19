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
