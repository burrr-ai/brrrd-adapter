import * as path from "node:path";

// brrrd runs packages on Linux, where `\` is an ordinary filename character,
// not a directory separator. Any path that ends up inside the deployment
// package (manifest entries, Next runtime manifests, generated module
// specifiers) must therefore use `/`, even when the build ran on Windows.

/** Rewrite every `\` separator to `/`. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Convert a path produced by the build host's `path` module to `/` separators.
 * On POSIX hosts `\` can legitimately appear in a filename, so it is only
 * rewritten when the host separator is `\` (Windows).
 */
export function hostPathToPosix(
  value: string,
  pathImpl: Pick<typeof path, "sep"> = path,
): string {
  return pathImpl.sep === "\\" ? toPosixPath(value) : value;
}

/** `path.relative` with a `/`-separated result, for paths written into build output. */
export function relativePosix(
  from: string,
  to: string,
  pathImpl: Pick<typeof path, "relative"> = path,
): string {
  return toPosixPath(pathImpl.relative(from, to));
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function normalizeRelativeField(value: unknown): unknown {
  if (typeof value !== "string" || isWindowsAbsolute(value)) return value;
  return toPosixPath(value);
}

function normalizeKey(target: Record<string, unknown>, key: string): void {
  if (key in target) target[key] = normalizeRelativeField(target[key]);
}

/**
 * Normalize the relative paths Next writes into `required-server-files.json`.
 *
 * Next computes `config.cacheHandler` and `config.cacheHandlers.*` with the
 * build host's `path.relative(distDir, handler)`, so a Windows build records
 * `..\node_modules\.cache\@brrrd\adapter\cache-handler-legacy.mjs`. The brrrd
 * runtime loads the cache handler from this manifest; on Linux that path does
 * not resolve and every cached route fails with 500.
 *
 * Host-absolute fields (`appDir`, `outputFileTracingRoot`, ...) are left alone:
 * they describe the build machine and are not resolved inside the package.
 */
export function normalizeRequiredServerFiles(manifest: any): { manifest: any; changed: boolean } {
  if (!manifest || typeof manifest !== "object") return { manifest, changed: false };
  const before = JSON.stringify(manifest);
  const next = JSON.parse(before);

  const config = next.config;
  if (config && typeof config === "object") {
    normalizeKey(config, "cacheHandler");
    normalizeKey(config, "distDir");
    if (config.cacheHandlers && typeof config.cacheHandlers === "object") {
      for (const key of Object.keys(config.cacheHandlers)) normalizeKey(config.cacheHandlers, key);
    }
  }
  normalizeKey(next, "relativeAppDir");
  for (const key of ["files", "ignore"]) {
    if (Array.isArray(next[key])) next[key] = next[key].map(normalizeRelativeField);
  }

  const changed = JSON.stringify(next) !== before;
  return { manifest: changed ? next : manifest, changed };
}
