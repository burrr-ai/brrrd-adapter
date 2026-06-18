import type { Metafile, Plugin } from "esbuild";
import type { BuildContext } from "../types.js";

export type CompatibilityTracedOutput = {
  filePath?: string;
  assets?: Record<string, string>;
};

export type CompatibilityPolicy = {
  name: string;
  plugins(ctx: BuildContext): Plugin[];
  afterBundle?(ctx: BuildContext, metafile: Metafile | undefined): void;
  shouldIgnoreNativeAsset?(
    assetPath: string,
    output: CompatibilityTracedOutput,
  ): boolean;
};
