import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import type { NextBuildModel } from "./model.js";
import type {
  BrrrdArtifact,
  BrrrdCompatibilityReport,
  BrrrdEdgeFunction,
  BrrrdImagesConfig,
  BrrrdLocalImagePattern,
  BrrrdManifest,
  BrrrdMiddleware,
  BrrrdPreviewConfig,
  BrrrdRemoteImagePattern,
  BrrrdRoute,
  BrrrdRouting,
} from "./types.js";

const require = createRequire(import.meta.url);

function adapterVersion(): string | undefined {
  try {
    const pkg = require("../package.json") as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

function deploymentId(): string | undefined {
  const value = process.env.NEXT_DEPLOYMENT_ID?.trim();
  return value ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => Number.isInteger(item) && item > 0)
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function remotePattern(value: unknown): BrrrdRemoteImagePattern | null {
  if (value instanceof URL) {
    return {
      protocol: value.protocol.replace(/:$/, ""),
      hostname: value.hostname,
      port: value.port || undefined,
      pathname: value.pathname || undefined,
      search: value.search || undefined,
    };
  }
  const pattern = objectValue(value);
  const hostname = optionalString(pattern.hostname);
  if (!hostname) return null;
  return {
    protocol: optionalString(pattern.protocol)?.replace(/:$/, ""),
    hostname,
    port: optionalString(pattern.port),
    pathname: optionalString(pattern.pathname),
    search: optionalString(pattern.search),
  };
}

function localPattern(value: unknown): BrrrdLocalImagePattern | null {
  const pattern = objectValue(value);
  const pathname = optionalString(pattern.pathname);
  const search = optionalString(pattern.search);
  if (pathname === undefined && search === undefined) return null;
  return { pathname, search };
}

function imageConfig(config: unknown): BrrrdImagesConfig {
  const images = objectValue(objectValue(config).images);
  const localPatterns = Array.isArray(images.localPatterns)
    ? images.localPatterns.map(localPattern).filter((item): item is BrrrdLocalImagePattern => item !== null)
    : undefined;
  const qualities = numberArray(images.qualities);
  const minimumCacheTTL = typeof images.minimumCacheTTL === "number" && images.minimumCacheTTL >= 0
    ? images.minimumCacheTTL
    : 14400;
  return {
    deviceSizes: numberArray(images.deviceSizes).length > 0
      ? numberArray(images.deviceSizes)
      : [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: numberArray(images.imageSizes).length > 0
      ? numberArray(images.imageSizes)
      : [32, 48, 64, 96, 128, 256, 384],
    domains: stringArray(images.domains),
    remotePatterns: Array.isArray(images.remotePatterns)
      ? images.remotePatterns.map(remotePattern).filter((item): item is BrrrdRemoteImagePattern => item !== null)
      : [],
    localPatterns,
    qualities: qualities.length > 0 ? qualities : [75],
    minimumCacheTTL,
  };
}

export function writeManifest(
  outDir: string,
  model: NextBuildModel,
  routes: BrrrdRoute[],
  env: Record<string, string>,
  routing: BrrrdRouting,
  artifacts: BrrrdArtifact[],
  compatibility: BrrrdCompatibilityReport,
  appBundle: string | undefined,
  middleware?: BrrrdMiddleware,
  edgeFunctions?: Record<string, BrrrdEdgeFunction>,
  pprPages: string[] = [],
  preview?: BrrrdPreviewConfig | null,
): void {
  const manifest: BrrrdManifest = {
    schemaVersion: 6,
    build: {
      buildId: model.buildId,
      deploymentId: deploymentId(),
      nextVersion: model.nextVersion,
      adapterVersion: adapterVersion(),
      createdAt: new Date().toISOString(),
    },
    buildId: model.buildId,
    appBundle,
    routes,
    staticDir: "static",
    prerendersDir: "prerenders",
    runtimeDir: "runtime",
    env,
    images: imageConfig(model.config),
    ...(preview ? { preview } : {}),
    artifacts,
    compatibility,
    routing,
    middleware,
    edgeFunctions,
    pprPages,
  };

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}
