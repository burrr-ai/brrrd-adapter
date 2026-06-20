import * as fs from "node:fs";
import * as path from "node:path";

import {
  createArtifactPlan,
  executeArtifactPlan,
  manifestArtifacts,
} from "./artifact-planner.js";
import { bundleAppHandler } from "./bundler.js";
import { validateCompatibility } from "./compatibility-validator.js";
import { writeManifest } from "./manifest-emitter.js";
import { createManifestSupplement, type ManifestSupplement } from "./manifest-supplement.js";
import {
  allOutputs,
  createNextBuildModel,
  requestOutputs,
  type AdapterBuildContext,
} from "./model.js";
import { compileRouteTable, compileRouting } from "./routing-compiler.js";
import { sanitizeId } from "./routing.js";
import type { BuildContext, BrrrdEdgeFunction, BrrrdMiddleware } from "./types.js";

function proxySourceFor(middleware: BrrrdMiddleware): "middleware" | "proxy" {
  const probe = [
    middleware.name,
    middleware.page,
    middleware.entry,
  ].join("\n").toLowerCase();
  return probe.includes("proxy") ? "proxy" : "middleware";
}

function middlewareFromSupplement(
  supplement: ManifestSupplement,
): BrrrdMiddleware | undefined {
  const middleware = supplement.middleware;
  if (!middleware) return undefined;
  return {
    files: middleware.files,
    runtime: middleware.runtimeRel,
    entry: middleware.entryRel,
    name: middleware.name,
    page: middleware.page,
    matchers: middleware.matchers,
    wasm: middleware.wasm,
    assets: middleware.assets,
    env: middleware.env,
  };
}

function edgeFunctionsFromSupplement(
  supplement: ManifestSupplement,
): Record<string, BrrrdEdgeFunction> | undefined {
  if (supplement.edgeFunctions.size === 0) return undefined;
  return Object.fromEntries(supplement.edgeFunctions);
}

function isEdgeRuntime(runtime: string | undefined): boolean {
  return runtime === "edge" || runtime === "experimental-edge";
}

function writeFallbackAppBundle(outDir: string): void {
  fs.writeFileSync(
    path.join(outDir, "bundles", "app.js"),
    [
      "export default async function brrrdFallbackHandler(_routeId, _req, res) {",
      "  res.writeHead(404, { 'content-type': 'text/plain' });",
      "  res.end('Not Found');",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
}

export async function onBuildComplete(ctx: AdapterBuildContext): Promise<void> {
  const outDir = path.join(ctx.projectDir, "dist", "brrrd");

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "bundles"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "static"), { recursive: true });

  const model = createNextBuildModel(ctx);
  const supplement = createManifestSupplement(model.distDir);
  const requestOutputList = requestOutputs(model);
  const compatibility = validateCompatibility(model, requestOutputList, allOutputs(model), supplement);

  const buildCtx: BuildContext = {
    projectDir: model.projectDir,
    distDir: model.distDir,
    outDir,
    buildId: model.buildId,
  };

  console.log(`[@brrrd/adapter] Building for brrrd runtime...`);
  console.log(`  Project: ${model.projectDir}`);
  console.log(`  Next.js: ${model.nextVersion}`);
  console.log(`  Build ID: ${model.buildId}`);

  const nodeOutputs = requestOutputList
    .filter((output): output is typeof output & { filePath: string } => (
      typeof output.filePath === "string" && !isEdgeRuntime(output.runtime)
    ))
    .map((output) => ({ ...output, id: sanitizeId(output.id) }));

  if (nodeOutputs.length > 0) {
    await bundleAppHandler(nodeOutputs, buildCtx);
    console.log(`  Bundled ${nodeOutputs.length} handlers into app.js`);
  }
  const hasEdgeFunctions = supplement.edgeFunctions.size > 0;
  if (nodeOutputs.length === 0 && hasEdgeFunctions) {
    writeFallbackAppBundle(outDir);
    console.log("  Wrote fallback dispatcher for edge-only app");
  }

  const artifactPlan = createArtifactPlan(model, supplement, outDir, {
    hasAppBundle: nodeOutputs.length > 0 || hasEdgeFunctions,
  });
  const copySummary = executeArtifactPlan(artifactPlan, outDir);
  console.log(
    `  Copied ${copySummary.staticCount} static files (${copySummary.compressedCount} precompressed)`,
  );
  console.log(`  Copied ${copySummary.prerenderCount} prerenders`);
  console.log(`  Copied ${copySummary.runtimeCount} runtime files`);
  if (copySummary.middlewareCount > 0) {
    console.log(`  Copied ${copySummary.middlewareCount} proxy/middleware files`);
  }
  if (copySummary.edgeFunctionCount > 0) {
    console.log(`  Copied ${copySummary.edgeFunctionCount} edge function files`);
  }

  const routes = compileRouteTable(model, supplement);
  const routing = compileRouting(model, supplement);
  const middleware = middlewareFromSupplement(supplement);
  const edgeFunctions = edgeFunctionsFromSupplement(supplement);
  if (middleware) {
    routing.proxy = {
      source: proxySourceFor(middleware),
    };
    console.log(
      `  Proxy/middleware: ${middleware.entry} (${middleware.matchers.length} matchers, ${middleware.wasm.length} wasm, ${middleware.assets.length} assets)`,
    );
  }

  const rewriteCount = routing.rewrites.beforeFiles.length
    + routing.rewrites.afterFiles.length
    + routing.rewrites.fallback.length;
  if (routing.headers.length > 0 || routing.redirects.length > 0 || rewriteCount > 0) {
    console.log(
      `  Routing rules: ${routing.headers.length} headers, ${routing.redirects.length} redirects, ${rewriteCount} rewrites`,
    );
  }
  if (supplement.pprPages.length > 0) {
    console.log(
      `  PPR enabled for ${supplement.pprPages.length} page(s): ${supplement.pprPages.join(", ")}`,
    );
  }
  if (edgeFunctions) {
    console.log(`  Edge functions: ${Object.keys(edgeFunctions).length}`);
  }

  const env: Record<string, string> = {
    NODE_ENV: "production",
    NEXT_RUNTIME: "nodejs",
    __NEXT_PRIVATE_PREBUNDLED_REACT: "next",
  };

  writeManifest(
    outDir,
    model,
    routes,
    env,
    routing,
    manifestArtifacts(artifactPlan),
    compatibility,
    nodeOutputs.length > 0 || hasEdgeFunctions ? "bundles/app.js" : undefined,
    middleware,
    edgeFunctions,
    supplement.pprPages,
  );
  console.log(`  Manifest written to ${path.join(outDir, "manifest.json")}`);
  console.log(`[@brrrd/adapter] Done!`);
}
