import * as path from "node:path";

import { shouldIgnoreNativeAssetForCompatibility } from "./compatibility/index.js";
import type { NextBuildModel, NormalizedOutput } from "./model.js";
import type { BrrrdCompatibilityReport } from "./types.js";
import { sanitizeId } from "./routing.js";

function isNativeBinding(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".node";
}

function isEdgeRuntime(runtime: string | undefined): boolean {
  return runtime === "edge" || runtime === "experimental-edge";
}

function assertEdgeOutputsHaveFunctionMetadata(
  outputs: NormalizedOutput[],
  registry: { edgeFunctions: Map<string, unknown> },
): void {
  const edgeOutputs = outputs.filter((output) => isEdgeRuntime(output.runtime));
  if (edgeOutputs.length === 0) return;

  const missing = edgeOutputs.filter((output) => (
    !registry.edgeFunctions.has(sanitizeId(output.id))
  ));
  if (missing.length === 0) return;

  throw new Error([
    "edge app/page/api route outputs are missing Adapter API edgeRuntime metadata or middleware-manifest.functions fallback metadata.",
    ...missing.map((output) => (
      `  - ${output.id} (${output.pathname}, runtime=${output.runtime ?? "unknown"})`
    )),
  ].join("\n"));
}

function assertNoNativeBindings(outputs: NormalizedOutput[]): void {
  const nativeFiles: string[] = [];
  for (const output of outputs) {
    if (output.filePath && isNativeBinding(output.filePath)) {
      nativeFiles.push(output.filePath);
    }
    for (const assetPath of Object.values(output.assets)) {
      if (
        isNativeBinding(assetPath)
        && !shouldIgnoreNativeAssetForCompatibility(assetPath, output)
      ) {
        nativeFiles.push(assetPath);
      }
    }
  }
  if (nativeFiles.length > 0) {
    throw new Error(
      `native Node addons (.node) are not supported in brrrd isolates:\n${nativeFiles.map((file) => `  - ${file}`).join("\n")}`,
    );
  }
}

export function validateCompatibility(
  model: NextBuildModel,
  requestOutputs: NormalizedOutput[],
  allOutputs: NormalizedOutput[],
  registry: { edgeFunctions: Map<string, unknown> },
): BrrrdCompatibilityReport {
  assertEdgeOutputsHaveFunctionMetadata(requestOutputs, registry);
  assertNoNativeBindings(allOutputs);
  return {
    policies: [
      {
        name: "native-node-addons",
        action: "validated",
        detail: "traced .node assets are rejected unless an explicit compatibility policy owns them",
      },
      {
        name: "edge-app-route-outputs",
        action: "validated",
        detail: "edge app/page/api outputs are backed by Adapter API edgeRuntime metadata, with middleware-manifest.functions as fallback, and executed through the edge bridge",
      },
      {
        name: "next-og",
        action: "applied",
        detail: "next/og uses the edge/WASM renderer compatibility policy during bundling",
      },
      {
        name: "runtime-dependency-policy",
        action: "applied",
        detail: "brrrd-provided builtins and missing optional Next runtime dependencies are handled by a shared bundler/runtime require policy",
      },
      {
        name: "next-version",
        action: "validated",
        detail: `build used Next.js ${model.nextVersion}`,
      },
    ],
  };
}
