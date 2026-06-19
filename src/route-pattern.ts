import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type NextRouteRegexModule = {
  getRouteRegex?: (
    pathname: string,
    options?: {
      includePrefix?: boolean;
      includeSuffix?: boolean;
      excludeOptionalTrailingSlash?: boolean;
    },
  ) => { re: RegExp };
};

function nextRouteRegex(pathname: string): string | null {
  try {
    const mod = require("next/dist/shared/lib/router/utils/route-regex") as NextRouteRegexModule;
    const compiled = mod.getRouteRegex?.(pathname, {
      includePrefix: true,
      includeSuffix: true,
    });
    return compiled?.re?.source ?? null;
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDynamicSegment(segment: string):
  | { prefix: string; suffix: string; repeat: boolean; optional: boolean }
  | null {
  const match = segment.match(/^([^\[]*)\[((?:\[\.\.\.[^\]]+\])|(?:\.\.\.[^\]]+)|(?:[^\]]+))\](.*)$/);
  if (!match) return null;
  const token = match[2];
  if (token.startsWith("[...") && token.endsWith("]")) {
    return { prefix: match[1], suffix: match[3], repeat: true, optional: true };
  }
  if (token.startsWith("...")) {
    return { prefix: match[1], suffix: match[3], repeat: true, optional: false };
  }
  return { prefix: match[1], suffix: match[3], repeat: false, optional: false };
}

function fallbackRouteRegex(pathname: string): string {
  if (pathname === "/") return "^\\/(?:/)?$";
  const parts = pathname.replace(/\/$/, "").replace(/^\//, "").split("/");
  const segments = parts.map((segment) => {
    const dynamic = parseDynamicSegment(segment);
    if (!dynamic) return `/${escapeRegex(segment)}`;
    const prefix = escapeRegex(dynamic.prefix);
    const suffix = escapeRegex(dynamic.suffix);
    if (dynamic.repeat) {
      return dynamic.optional
        ? `(?:/${prefix}(.+?)${suffix})?`
        : `/${prefix}(.+?)${suffix}`;
    }
    return `/${prefix}([^/]+?)${suffix}`;
  });
  return `^${segments.join("")}(?:/)?$`;
}

export function routeRegexFromPathname(pathname: string): string {
  return nextRouteRegex(pathname) ?? fallbackRouteRegex(pathname);
}
