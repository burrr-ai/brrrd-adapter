import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin } from "esbuild";

import type { BuildContext } from "../types.js";
import type { CompatibilityPolicy } from "./types.js";

const NEXT_SERVER_SOURCE_MAP_NAMESPACE = "brrrd-next-server-source-map";

function comparablePath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(comparablePath(dir), comparablePath(filePath));
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function createNextServerSourceMapPlugin(ctx: BuildContext): Plugin {
  const serverDir = path.join(ctx.distDir, "server");

  const emptyServerSourceMap = () => ({
    contents: "module.exports = {};\n",
    loader: "js" as const,
  });

  return {
    name: "brrrd-next-server-source-map",
    setup(build) {
      build.onResolve({ filter: /\.map$/ }, (args) => {
        const candidate = path.isAbsolute(args.path)
          ? args.path
          : path.resolve(args.resolveDir, args.path);
        if (!isInsideDir(candidate, serverDir)) return undefined;

        return {
          path: candidate,
          namespace: NEXT_SERVER_SOURCE_MAP_NAMESPACE,
        };
      });

      build.onLoad({ filter: /.*/, namespace: NEXT_SERVER_SOURCE_MAP_NAMESPACE }, () => {
        return emptyServerSourceMap();
      });

      build.onLoad({ filter: /\.map$/ }, (args) => {
        if (isInsideDir(args.path, serverDir)) return emptyServerSourceMap();

        return {
          errors: [{
            text: `source map imports outside Next server output are not executable: ${args.path}`,
          }],
        };
      });
    },
  };
}

export const nextServerSourceMapPolicy: CompatibilityPolicy = {
  name: "next-server-source-map",
  plugins: (ctx) => [createNextServerSourceMapPlugin(ctx)],
};
