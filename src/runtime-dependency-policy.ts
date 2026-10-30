import type { Plugin } from "esbuild";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";

import type { BuildContext } from "./types.js";

const require = createRequire(import.meta.url);

const BRRRD_NODE_MODULES = [
  "fs", "fs/promises", "path", "buffer", "crypto",
  "stream", "stream/web", "stream/promises",
  "events", "process", "util", "url", "zlib",
  "http", "https", "os", "async_hooks",
  "string_decoder", "querystring", "assert",
  "timers", "timers/promises", "constants",
  "net", "tls", "dns", "child_process", "vm",
  "http2", "readline", "worker_threads",
  "tty", "perf_hooks", "diagnostics_channel", "module",
] as const;

const RUNTIME_PROVIDED_EXTERNALS = [
  "cloudflare:workers",
  ...BRRRD_NODE_MODULES,
  ...BRRRD_NODE_MODULES.map((moduleName) => `node:${moduleName}`),
];

const ALWAYS_EXTERNAL_PACKAGES = [
  "@opentelemetry/sdk-trace-base",
] as const;

const EMPTY_STUB_OPTIONAL_PACKAGES = [
  "encoding",
  "pnpapi",
  "bufferutil",
  "utf-8-validate",
  "inspector",
  "node:inspector",
  "perf_hooks",
  "node:perf_hooks",
  "diagnostics_channel",
  "node:diagnostics_channel",
] as const;

const EXTERNAL_IF_MISSING_PACKAGES = new Set<string>([
  ...EMPTY_STUB_OPTIONAL_PACKAGES,
]);

export function runtimeDependencyExternals(): string[] {
  return [
    ...RUNTIME_PROVIDED_EXTERNALS,
    ...ALWAYS_EXTERNAL_PACKAGES,
  ];
}

function resolveSearchPaths(ctx: BuildContext, resolveDir: string): string[] {
  return Array.from(new Set([
    resolveDir,
    ctx.projectDir,
    ctx.distDir,
    path.join(ctx.distDir, "server"),
  ].filter(Boolean)));
}

function canResolveFromBuild(specifier: string, ctx: BuildContext, resolveDir: string): boolean {
  try {
    require.resolve(specifier, { paths: resolveSearchPaths(ctx, resolveDir) });
    return true;
  } catch {
    return false;
  }
}

function isInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isBarePackageSpecifier(specifier: string): boolean {
  if (specifier.length === 0) return false;
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("\0")) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) return false;
  return true;
}

function owningNodeModulePackage(filePath: string): string | null {
  const parts = filePath.split(path.sep);
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] !== "node_modules") continue;
    const first = parts[i + 1];
    if (!first || first === ".pnpm") continue;
    if (first.startsWith("@")) {
      const second = parts[i + 2];
      return second ? `${first}/${second}` : null;
    }
    return first;
  }
  return null;
}

function isNextGeneratedRuntimeImporter(importer: string, ctx: BuildContext): boolean {
  if (!importer) return false;
  if (isInsideDir(importer, ctx.distDir)) return true;
  return owningNodeModulePackage(importer) === "next";
}

function isNodeModuleRuntimeImporter(importer: string): boolean {
  return !!importer && owningNodeModulePackage(importer) !== null;
}

export function createRuntimeDependencyPlugin(ctx: BuildContext): Plugin {
  return {
    name: "brrrd-runtime-dependency-policy",
    setup(build) {
      build.onLoad({ filter: /[\\/]next[\\/]dist[\\/]server[\\/]lib[\\/]router-utils[\\/]instrumentation-globals\.external\.js$/ }, args => ({
        contents: adaptOptionalInstrumentation(fs.readFileSync(args.path, "utf8")),
        loader: "js", resolveDir: path.dirname(args.path),
      }));
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === "@opentelemetry/api") {
          // Bundle the actual API, preferring the app's package. Next already ships its
          // vendored API; an absent SDK/provider must use its real no-op behavior.
          const paths = resolveSearchPaths(ctx, args.resolveDir);
          try {
            return { path: require.resolve(args.path, { paths }) };
          } catch {
            try {
              return { path: require.resolve("next/dist/compiled/@opentelemetry/api", { paths }) };
            } catch {
              return { path: require.resolve("next/dist/compiled/@opentelemetry/api") };
            }
          }
        }
        // Next can emit conditional runtime-only require() calls, such as the
        // Pages runtime CSS optimizer path. Preserve Node's late
        // MODULE_NOT_FOUND behavior for those generated/runtime files instead
        // of failing the adapter's esbuild pass.
        const lateRuntimeImport = isBarePackageSpecifier(args.path)
          && (
            args.kind === "require-call"
            || args.kind === "dynamic-import"
          )
          && (
            isNextGeneratedRuntimeImporter(args.importer, ctx)
            || isNodeModuleRuntimeImporter(args.importer)
          );
        const externalIfMissing = EXTERNAL_IF_MISSING_PACKAGES.has(args.path)
          || lateRuntimeImport;
        if (!externalIfMissing) return undefined;
        if (canResolveFromBuild(args.path, ctx, args.resolveDir)) return undefined;
        return {
          path: args.path,
          external: true,
        };
      });
    },
  };
}

export function runtimeRequireBanner(): string {
  return `
import { createRequire as __brrrdCreateRequire } from "node:module";
if (process.env.BRRRD_RUNTIME_ABI !== "workerd-node-v1") {
  throw new Error("artifact requires brrrd execution ABI workerd-node-v1; rebuild and use its matching runtime");
}
var require = __brrrdCreateRequire(import.meta.url);
var __filename = new URL(import.meta.url).pathname;
var __dirname = __filename.slice(0, __filename.lastIndexOf("/"));
`;
}


/** The hook itself is optional; a present hook's dependency/import failures are not. */
export function adaptOptionalInstrumentation(source: string): string {
  const start = "    try {\n        cachedInstrumentationModule =";
  const classifier = "if ((0, _iserror.default)(err) && err.code !== 'ENOENT' && err.code !== 'MODULE_NOT_FOUND' && err.code !== 'ERR_MODULE_NOT_FOUND') {\n            throw err;\n        }";
  if (source.split(start).length !== 2 || source.split(classifier).length !== 2) {
    throw new Error("unsupported Next optional instrumentation loader source");
  }
  const presence = `    try {
        require('node:fs').statSync(_nodepath.default.join(projectDir, distDir, 'server', _constants.INSTRUMENTATION_HOOK_FILENAME + '.js'));
    } catch (error) {
        if (error && error.code === 'ENOENT') return undefined;
        throw error;
    }
`;
  return source.replace(start, presence + start).replace(classifier, "throw err;");
}
