import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { Plugin } from "esbuild";
import type { BuildContext } from "../types.js";
import type { CompatibilityPolicy, CompatibilityTracedOutput } from "./types.js";

const NEXT_OG_IMPORT_RE = /^(next\/og|next\/dist\/api\/og|next\/dist\/server\/og\/image-response(?:\.js)?)$/;
const NEXT_OG_EDGE_ENTRY = "next/dist/compiled/@vercel/og/index.edge.js";
const NEXT_OG_COMPILED_ENTRY_RE = /^next\/dist\/compiled\/@vercel\/og\/index\.(?:node|edge)\.js$/;
const NEXT_OG_EDGE_ENTRY_RE = /next[\\/]dist[\\/]compiled[\\/]@vercel[\\/]og[\\/]index\.edge\.js$/;
const NEXT_OG_SHIM_NAMESPACE = "brrrd-next-og";
const NEXT_OG_EDGE_NAMESPACE = "brrrd-next-og-edge";
const NEXT_OG_WASM_MODULE_NAMESPACE = "brrrd-next-og-wasm-module";
const NEXT_OG_FALLBACK_FONT = "Geist-Regular.ttf";
const NEXT_OG_FALLBACK_FONT_FETCH_RE =
  /var fallbackFont = fetch\(\s*new URL\("\.\/Geist-Regular\.ttf", import\.meta\.url\)\s*\)\.then\(\(res\) => res\.arrayBuffer\(\)\);/;

const NEXT_OG_SHIM_SOURCE = `
function importModule() {
  return import("${NEXT_OG_EDGE_ENTRY}");
}

export class ImageResponse extends Response {
  static displayName = "ImageResponse";

  constructor(...args) {
    const readable = new ReadableStream({
      async start(controller) {
        const OGImageResponse = (await importModule()).ImageResponse;
        const imageResponse = new OGImageResponse(...args);
        if (!imageResponse.body) {
          controller.close();
          return;
        }
        const reader = imageResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        }
      },
    });
    const options = args[1] || {};
    const headers = new Headers({
      "content-type": "image/png",
      "cache-control": process.env.NODE_ENV === "development"
        ? "no-cache, no-store"
        : "public, max-age=0, must-revalidate",
    });
    if (options.headers) {
      const newHeaders = new Headers(options.headers);
      newHeaders.forEach((value, key) => headers.set(key, value));
    }
    super(readable, {
      headers,
      status: options.status,
      statusText: options.statusText,
    });
  }
}
`;

function normalizePathForMatch(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function resolveFromProject(ctx: BuildContext, specifier: string): string {
  const projectRequire = createRequire(path.join(ctx.projectDir, "package.json"));
  try {
    return projectRequire.resolve(specifier);
  } catch {
    return createRequire(import.meta.url).resolve(specifier);
  }
}

function isNextOgEdgeEntry(filePath: string): boolean {
  return NEXT_OG_EDGE_ENTRY_RE.test(normalizePathForMatch(filePath));
}

function isNextOgTraceFile(filePath: string): boolean {
  const normalized = normalizePathForMatch(filePath);
  return normalized.endsWith("/next/og.js")
    || normalized.endsWith("/next/dist/api/og.js")
    || normalized.endsWith("/next/dist/server/og/image-response.js")
    || normalized.endsWith("/next/dist/compiled/@vercel/og/index.node.js")
    || normalized.endsWith("/next/dist/compiled/@vercel/og/index.edge.js");
}

function outputUsesNextOg(output: CompatibilityTracedOutput): boolean {
  return [
    output.filePath,
    ...Object.values(output.assets ?? {}),
  ].some((assetPath) => typeof assetPath === "string" && isNextOgTraceFile(assetPath));
}

function isSharpNativeAsset(filePath: string): boolean {
  const normalized = normalizePathForMatch(filePath);
  return normalized.includes("/node_modules/@img/sharp-")
    || normalized.includes("/node_modules/sharp/");
}

function isSharpPackageInput(filePath: string): boolean {
  const normalized = normalizePathForMatch(filePath);
  return normalized.includes("/node_modules/sharp/")
    || normalized.includes("/node_modules/@img/sharp-");
}

function assertNoBundledSharp(metafile: { inputs?: Record<string, unknown> } | undefined): void {
  const sharpInputs = Object.keys(metafile?.inputs ?? {}).filter(isSharpPackageInput);
  if (sharpInputs.length === 0) return;

  throw new Error(
    [
      "sharp is not supported in brrrd isolates. next/og is rewritten to use Next's edge/WASM renderer, but direct sharp imports must be removed.",
      ...sharpInputs.map((input) => `  - ${input}`),
    ].join("\n"),
  );
}

function decodeBase64Expression(base64: string): string {
  return `Uint8Array.from(atob("${base64}"), (c) => c.charCodeAt(0))`;
}

function loadAssetBase64(ctx: BuildContext, name: string): string {
  const src = resolveFromProject(ctx, `next/dist/compiled/@vercel/og/${name}`);
  return fs.readFileSync(src).toString("base64");
}

function patchNextOgEdgeSource(ctx: BuildContext, source: string): string {
  const fontBase64 = loadAssetBase64(ctx, NEXT_OG_FALLBACK_FONT);
  const patched = source.replace(
    NEXT_OG_FALLBACK_FONT_FETCH_RE,
    `var fallbackFont = Promise.resolve(${decodeBase64Expression(fontBase64)}.buffer);`,
  );
  if (patched === source) {
    throw new Error("failed to patch next/og edge fallback font loader");
  }
  return patched;
}

function wasmModuleSource(absPath: string): string {
  const base64 = fs.readFileSync(absPath).toString("base64");
  return `export default ${decodeBase64Expression(base64)};\n`;
}

function createNextOgPlugin(ctx: BuildContext): Plugin {
  return {
    name: "brrrd-next-og",
    setup(build) {
      build.onResolve({ filter: NEXT_OG_IMPORT_RE }, () => ({
        path: "image-response",
        namespace: NEXT_OG_SHIM_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: NEXT_OG_SHIM_NAMESPACE }, () => ({
        contents: NEXT_OG_SHIM_SOURCE,
        loader: "js",
        resolveDir: ctx.projectDir,
      }));
      build.onResolve({ filter: NEXT_OG_COMPILED_ENTRY_RE }, () => ({
        path: resolveFromProject(ctx, NEXT_OG_EDGE_ENTRY),
        namespace: NEXT_OG_EDGE_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: NEXT_OG_EDGE_NAMESPACE }, (args) => ({
        contents: patchNextOgEdgeSource(ctx, fs.readFileSync(args.path, "utf8")),
        loader: "js",
        resolveDir: path.dirname(args.path),
      }));
      build.onResolve({ filter: /\.wasm\?module$/ }, (args) => {
        if (!isNextOgEdgeEntry(args.importer) && args.namespace !== NEXT_OG_EDGE_NAMESPACE) {
          return undefined;
        }
        return {
          path: path.resolve(args.resolveDir, args.path.replace(/\?module$/, "")),
          namespace: NEXT_OG_WASM_MODULE_NAMESPACE,
        };
      });
      build.onLoad({ filter: /.*/, namespace: NEXT_OG_WASM_MODULE_NAMESPACE }, (args) => ({
        contents: wasmModuleSource(args.path),
        loader: "js",
      }));
    },
  };
}

export const nextOgPolicy: CompatibilityPolicy = {
  name: "next-og",
  plugins: (ctx) => [createNextOgPlugin(ctx)],
  afterBundle(_ctx, metafile) {
    assertNoBundledSharp(metafile);
  },
  shouldIgnoreNativeAsset(assetPath, output) {
    return outputUsesNextOg(output) && isSharpNativeAsset(assetPath);
  },
};
