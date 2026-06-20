import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import type { NextBuildModel } from "./model.js";
import type {
  BrrrdArtifact,
  BrrrdCompatibilityReport,
  BrrrdEdgeFunction,
  BrrrdManifest,
  BrrrdMiddleware,
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
): void {
  const manifest: BrrrdManifest = {
    schemaVersion: 5,
    build: {
      buildId: model.buildId,
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
