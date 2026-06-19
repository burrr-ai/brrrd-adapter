import type { NextBuildModel } from "./model.js";
import { listPrerenderPathnames } from "./routing.js";

function normalizePathname(pathname: string): string {
  if (pathname === "") return "/";
  const withSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return withSlash.length > 1 && withSlash.endsWith("/")
    ? withSlash.slice(0, -1)
    : withSlash;
}

export function publicArtifactPathnames(model: NextBuildModel): string[] {
  return [
    ...model.outputs.staticFiles.map((output) => output.pathname),
    ...listPrerenderPathnames(model.outputs.prerenders),
  ];
}

export function publicStorageFilePath(
  pathname: string,
  allPublicPathnames: readonly string[],
): string {
  const normalized = normalizePathname(pathname);
  if (normalized === "/") return "/";

  const normalizedAll = allPublicPathnames.map(normalizePathname);
  const prefix = `${normalized}/`;
  const hasChild = normalizedAll.some((candidate) => (
    candidate !== normalized && candidate.startsWith(prefix)
  ));
  return hasChild ? `${normalized}/index` : normalized;
}

export function publicStoragePackagePath(
  pathname: string,
  allPublicPathnames: readonly string[],
): string {
  const storagePath = publicStorageFilePath(pathname, allPublicPathnames);
  if (storagePath === "/") return "index";
  return storagePath.replace(/^\//, "");
}
