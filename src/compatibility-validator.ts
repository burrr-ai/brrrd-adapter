import * as path from "node:path";

import { shouldIgnoreNativeAssetForCompatibility } from "./compatibility/index.js";
import type { NextBuildModel, NormalizedOutput } from "./model.js";
import type { BrrrdCompatibilityReport } from "./types.js";

function isNativeBinding(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".node";
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
  allOutputs: NormalizedOutput[],
): BrrrdCompatibilityReport {
  assertNoNativeBindings(allOutputs);
  return {
    policies: [
      {
        name: "native-node-addons",
        action: "validated",
        detail: "traced .node assets are rejected unless an explicit compatibility policy owns them",
      },
      {
        name: "node-runtime-only",
        action: "validated",
        detail: "Edge outputs are rejected before packaging; only Node routes and proxy/middleware are admitted",
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
