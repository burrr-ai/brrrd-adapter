import * as fs from "node:fs";
import * as path from "node:path";

import type { AdapterBuildContext, NextBuildModel } from "./model.js";

type Jsonish =
  | null
  | string
  | number
  | boolean
  | Jsonish[]
  | { [key: string]: Jsonish };

function enabledValue(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function adapterContextSnapshotEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return enabledValue(env.BRRRD_ADAPTER_DEBUG_CONTEXT)
    || enabledValue(env.BRRRD_HARNESS_CAPTURE_CONTEXT);
}

function safeJson(value: unknown, depth = 0, seen = new WeakSet<object>()): Jsonish {
  if (value === null) return null;
  if (value === undefined) return "[undefined]";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function ${(value as Function).name || "anonymous"}]`;
  if (depth >= 8) return "[MaxDepth]";
  if (Array.isArray(value)) {
    return value.map((item) => safeJson(item, depth + 1, seen));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
    };
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, Jsonish> = {};
    for (const [key, child] of entries) {
      result[key] = safeJson(child, depth + 1, seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

function configSummary(config: unknown): Jsonish {
  if (!config || typeof config !== "object") return safeJson(config);
  const raw = config as Record<string, unknown>;
  const experimental = raw.experimental && typeof raw.experimental === "object"
    ? raw.experimental as Record<string, unknown>
    : {};
  return safeJson({
    basePath: raw.basePath,
    i18n: raw.i18n,
    trailingSlash: raw.trailingSlash,
    output: raw.output,
    assetPrefix: raw.assetPrefix,
    distDir: raw.distDir,
    experimental: {
      cacheComponents: experimental.cacheComponents,
      ppr: experimental.ppr,
      typedRoutes: experimental.typedRoutes,
    },
  });
}

export function createAdapterContextSnapshot(
  ctx: AdapterBuildContext,
  model: NextBuildModel,
): Jsonish {
  return safeJson({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    projectDir: ctx.projectDir,
    repoRoot: ctx.repoRoot,
    distDir: ctx.distDir,
    nextVersion: ctx.nextVersion,
    buildId: ctx.buildId,
    config: configSummary(ctx.config),
    raw: {
      routing: ctx.routing ?? null,
      outputs: ctx.outputs,
    },
    normalized: {
      routing: model.routing,
      outputs: model.outputs,
    },
  });
}

export function writeAdapterContextSnapshot(
  outDir: string,
  ctx: AdapterBuildContext,
  model: NextBuildModel,
): string {
  const file = path.join(outDir, "adapter-context.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify(createAdapterContextSnapshot(ctx, model), null, 2)}\n`,
    "utf8",
  );
  return file;
}
