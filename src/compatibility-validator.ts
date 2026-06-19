import * as path from "node:path";

import { shouldIgnoreNativeAssetForCompatibility } from "./compatibility/index.js";
import type { NextBuildModel, NormalizedOutput } from "./model.js";
import type { BrrrdCompatibilityReport } from "./types.js";

function isNativeBinding(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".node";
}

function isEdgeRuntime(runtime: string | undefined): boolean {
  return runtime === "edge" || runtime === "experimental-edge";
}

function assertNoUnsupportedEdgeOutputs(outputs: NormalizedOutput[]): void {
  const edgeOutputs = outputs.filter((output) => isEdgeRuntime(output.runtime));
  if (edgeOutputs.length === 0) return;

  throw new Error(
    [
      "edge app/page/api route outputs are not supported in brrrd isolates. Only Next proxy/middleware edge bundles use the dedicated edge bridge; app routes must use the nodejs runtime or be emitted as static assets.",
      ...edgeOutputs.map((output) => (
        `  - ${output.id} (${output.pathname}, runtime=${output.runtime ?? "unknown"})`
      )),
    ].join("\n"),
  );
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
): BrrrdCompatibilityReport {
  assertNoUnsupportedEdgeOutputs(requestOutputs);
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
        detail: "edge app/page/api outputs are rejected; proxy/middleware is handled separately",
      },
      {
        name: "next-og",
        action: "applied",
        detail: "next/og uses the edge/WASM renderer compatibility policy during bundling",
      },
      {
        name: "next-version",
        action: "validated",
        detail: `build used Next.js ${model.nextVersion}`,
      },
    ],
  };
}
