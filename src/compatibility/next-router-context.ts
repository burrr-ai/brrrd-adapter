import type { Plugin } from "esbuild";
import { createRequire } from "node:module";
import * as path from "node:path";

import type { BuildContext } from "../types.js";
import type { CompatibilityPolicy } from "./types.js";

const NEXT_ROUTER_CONTEXT_NAMESPACE = "brrrd-next-router-context-singleton";
const require = createRequire(import.meta.url);
const VENDORED_ROUTER_CONTEXT_SPECIFIER =
  "next/dist/server/route-modules/pages/vendored/contexts/router-context";
const SHARED_ROUTER_CONTEXT_RE =
  /(?:^|[\\/])next[\\/]dist[\\/]shared[\\/]lib[\\/]router-context\.shared-runtime(?:\.js)?$/;
const SHARED_ROUTER_CONTEXT_SPECIFIER_RE =
  /^next\/dist\/shared\/lib\/router-context\.shared-runtime(?:\.js)?$/;

function resolveNextModule(specifier: string, ctx: BuildContext): string {
  try {
    return require.resolve(specifier, {
      paths: [
        ctx.projectDir,
        ctx.distDir,
        path.join(ctx.distDir, "server"),
      ],
    });
  } catch {
    return require.resolve(specifier);
  }
}

function createNextRouterContextPlugin(ctx: BuildContext): Plugin {
  const vendoredRouterContextPath = resolveNextModule(
    VENDORED_ROUTER_CONTEXT_SPECIFIER,
    ctx,
  );
  const singletonModule = () => ({
    contents: routerContextSingletonModule(path.basename(vendoredRouterContextPath)),
    loader: "js" as const,
    resolveDir: path.dirname(vendoredRouterContextPath),
  });
  return {
    name: "brrrd-next-router-context-singleton",
    setup(build) {
      build.onResolve({ filter: SHARED_ROUTER_CONTEXT_SPECIFIER_RE }, (args) => ({
        path: args.path,
        namespace: NEXT_ROUTER_CONTEXT_NAMESPACE,
      }));

      build.onLoad({ filter: SHARED_ROUTER_CONTEXT_RE }, singletonModule);

      build.onLoad({ filter: /.*/, namespace: NEXT_ROUTER_CONTEXT_NAMESPACE }, singletonModule);
    },
  };
}

function routerContextSingletonModule(vendoredRouterContextFilename: string): string {
  return `
const vendoredRouterContext = require(${JSON.stringify(`./${vendoredRouterContextFilename}`)});
const RouterContext =
  vendoredRouterContext.RouterContext ||
  (vendoredRouterContext.default && vendoredRouterContext.default.RouterContext) ||
  vendoredRouterContext.default ||
  vendoredRouterContext;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RouterContext = RouterContext;
exports.default = { RouterContext };
`;
}

export const nextRouterContextPolicy: CompatibilityPolicy = {
  name: "next-router-context-singleton",
  plugins: (ctx) => [createNextRouterContextPlugin(ctx)],
};
