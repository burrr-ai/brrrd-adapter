import * as fs from "node:fs";
import type { Plugin } from "esbuild";

import type { BuildContext } from "../types.js";
import type { CompatibilityPolicy } from "./types.js";

const TURBOPACK_SERVER_RUNTIME_RE = /[\\/]server[\\/]chunks[\\/](?:ssr[\\/])?\[turbopack\]_runtime\.js$/;
const RUNTIME_ROOT_RE = /\b(?:var|const)\s+RUNTIME_ROOT\s*=\s*path\.resolve\(__filename,\s*relativePathToRuntimeRoot\);/;
const ABSOLUTE_ROOT_RE = /\b(?:var|const)\s+ABSOLUTE_ROOT\s*=\s*path\.resolve\(__filename,\s*relativePathToDistRoot\);/;

function patchTurbopackServerRuntime(source: string): string {
  const withRuntimeRoot = source.replace(
    RUNTIME_ROOT_RE,
    "const RUNTIME_ROOT = globalThis.__brrrd_turbopack_runtime_root || path.resolve(__filename, relativePathToRuntimeRoot);",
  );
  const patched = withRuntimeRoot.replace(
    ABSOLUTE_ROOT_RE,
    "const ABSOLUTE_ROOT = globalThis.__brrrd_turbopack_dist_root || path.resolve(__filename, relativePathToDistRoot);",
  );
  if (patched === source || patched === withRuntimeRoot) {
    throw new Error("failed to patch Turbopack server runtime root");
  }
  return patched;
}

function createTurbopackServerRuntimePlugin(_ctx: BuildContext): Plugin {
  return {
    name: "brrrd-turbopack-server-runtime",
    setup(build) {
      build.onLoad({ filter: TURBOPACK_SERVER_RUNTIME_RE }, (args) => ({
        contents: patchTurbopackServerRuntime(fs.readFileSync(args.path, "utf8")),
        loader: "js",
      }));
    },
  };
}

export const turbopackServerPolicy: CompatibilityPolicy = {
  name: "turbopack-server-runtime",
  plugins: (ctx) => [createTurbopackServerRuntimePlugin(ctx)],
};
