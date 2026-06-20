import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import type { NextConfigComplete } from "next/dist/server/config-shared.js";

const require = createRequire(import.meta.url);
const SUPPORT_DIR = path.join("node_modules", ".cache", "@brrrd", "adapter");

type BuildBundler = "webpack" | "turbopack";
type ModifyConfigContext = {
  phase: string;
  nextVersion: string;
  projectDir?: string;
};

function envFlag(name: string): boolean | undefined {
  const value = process.env[name]?.toLowerCase();
  if (value === undefined || value === "") {
    return undefined;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return true;
}

function envTurbopackMode(): boolean | undefined {
  const value = process.env.TURBOPACK?.toLowerCase();
  if (value === undefined || value === "") {
    return undefined;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return true;
}

function cliFlag(name: string): boolean {
  return process.argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function nextMajor(version: string): number | undefined {
  const match = /^(\d+)/.exec(version);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}

export function detectBuildBundler(ctx: { nextVersion: string }): BuildBundler {
  if (envFlag("IS_WEBPACK_TEST")) {
    return "webpack";
  }
  if (envFlag("IS_TURBOPACK_TEST")) {
    return "turbopack";
  }

  const turbopackMode = envTurbopackMode();
  if (turbopackMode !== undefined) {
    return turbopackMode ? "turbopack" : "webpack";
  }

  if (cliFlag("--webpack")) {
    return "webpack";
  }
  if (cliFlag("--turbopack") || cliFlag("--turbo")) {
    return "turbopack";
  }

  return (nextMajor(ctx.nextVersion) ?? 0) >= 16 ? "turbopack" : "webpack";
}

function supportsModernCacheHandlerInjection(ctx: { nextVersion: string }): boolean {
  return detectBuildBundler(ctx) === "webpack";
}

function materializeSupportFile(projectDir: string, variant: string): string {
  const source = require.resolve(`@brrrd/adapter/${variant}`);
  const target = path.join(projectDir, SUPPORT_DIR, `${variant}.mjs`);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const sourceBytes = fs.readFileSync(source);
  let shouldWrite = true;
  try {
    shouldWrite = !fs.readFileSync(target).equals(sourceBytes);
  } catch {
    shouldWrite = true;
  }
  if (shouldWrite) {
    fs.writeFileSync(target, sourceBytes);
  }

  return target;
}

function resolveProjectDir(ctx: ModifyConfigContext): string {
  return ctx.projectDir ?? process.cwd();
}

export function modifyConfig(
  config: NextConfigComplete,
  ctx: ModifyConfigContext,
): NextConfigComplete {
  const projectDir = resolveProjectDir(ctx);
  const modernCacheHandler = materializeSupportFile(projectDir, "cache-handler");
  const legacyCacheHandler = materializeSupportFile(projectDir, "cache-handler-legacy");

  // Modern `cacheHandlers` expects handler objects. The module is safe to import
  // during `next build` and delegates to brrrd cache ops inside the isolate.
  //
  // Next 16.3 canary currently fails Turbopack Edge app-route builds when this
  // hook injects non-empty `cacheHandlers` into the edge-app-route template.
  // Keep legacy cache support enabled everywhere, and register the modern
  // handler only for bundlers with known-safe template expansion.
  if (supportsModernCacheHandlerInjection(ctx)) {
    config.cacheHandlers = config.cacheHandlers ?? {};
    if (!config.cacheHandlers.default) {
      config.cacheHandlers.default = modernCacheHandler;
    }
  }
  // Legacy IncrementalCache interface — for unstable_cache, fetch revalidate, and page ISR.
  if (!config.cacheHandler) {
    config.cacheHandler = legacyCacheHandler;
  }

  // Do not set output: 'standalone'.
  // The Adapter API provides per-route output (filePath + assets), so standalone is not needed.

  return config;
}
