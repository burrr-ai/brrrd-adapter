import type { Metafile, Plugin } from "esbuild";
import type { BuildContext } from "../types.js";
import { nextOgPolicy } from "./next-og.js";
import type { CompatibilityPolicy, CompatibilityTracedOutput } from "./types.js";

// Central registry for Next built-in behavior that needs platform adaptation.
// Build and bundle stages call this registry instead of knowing individual
// module quirks such as @vercel/og assets or optional native fallbacks.
const POLICIES: CompatibilityPolicy[] = [
  nextOgPolicy,
];

export function createCompatibilityPlugins(ctx: BuildContext): Plugin[] {
  return POLICIES.flatMap((policy) => policy.plugins(ctx));
}

export function runCompatibilityAfterBundle(
  ctx: BuildContext,
  metafile: Metafile | undefined,
): void {
  for (const policy of POLICIES) {
    policy.afterBundle?.(ctx, metafile);
  }
}

export function shouldIgnoreNativeAssetForCompatibility(
  assetPath: string,
  output: CompatibilityTracedOutput,
): boolean {
  return POLICIES.some(
    (policy) => policy.shouldIgnoreNativeAsset?.(assetPath, output) === true,
  );
}
