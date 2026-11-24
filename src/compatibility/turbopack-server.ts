import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { Plugin, PluginBuild, ResolveResult } from "esbuild";

import type { BuildContext } from "../types.js";
import type { CompatibilityPolicy } from "./types.js";

const require = createRequire(import.meta.url);
const RUNTIME_RE = /[\\/]server[\\/]chunks[\\/](?:ssr[\\/])?\[turbopack\]_runtime\.js$/;
const GRAPH = "brrrd:turbopack-node-graph";
const RUNTIME_ROOT_RE = /\b(?:var|const)\s+RUNTIME_ROOT\s*=\s*path\.resolve\(__filename,\s*relativePathToRuntimeRoot\);/;
const ABSOLUTE_ROOT_RE = /\b(?:var|const)\s+ABSOLUTE_ROOT\s*=\s*path\.resolve\(__filename,\s*relativePathToDistRoot\);/;

type External = { id: string; importer: string; kind: "require-call" | "require-resolve" | "dynamic-import" };
type ImportBinding = { specifier: string; resolved: ResolveResult };
type NodeGraph = { contents: string; bindings: Map<string, ResolveResult> };

function memberName(node: any): string | undefined {
  return node?.type === "MemberExpression"
    ? node.computed ? node.property.value : node.property.name
    : undefined;
}

function chunkFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return chunkFiles(file);
    return entry.name.endsWith(".js") && !RUNTIME_RE.test(file) ? [file] : [];
  }).sort();
}

function externals(ctx: BuildContext, files: string[]): External[] {
  let parser;
  try { parser = require(require.resolve("next/dist/compiled/acorn", { paths: [ctx.projectDir] })); }
  catch { parser = require("next/dist/compiled/acorn"); }
  const result: External[] = [];
  for (const importer of files) {
    const tree = parser.parse(fs.readFileSync(importer, "utf8"), { ecmaVersion: "latest", sourceType: "module" });
    const factories = tree.body.flatMap((statement: any) => {
      const assignment = statement.type === "ExpressionStatement" ? statement.expression : undefined;
      const left = assignment?.left;
      if (assignment?.type !== "AssignmentExpression" || left?.type !== "MemberExpression"
        || left.object.name !== "module" || left.property.name !== "exports"
        || assignment.right.type !== "ArrayExpression") return [];
      const arrays = [assignment.right];
      const result = [];
      while (arrays.length) {
        for (const node of arrays.pop().elements) {
          if (node?.type === "ArrayExpression") arrays.push(node);
          else if (node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression") result.push(node);
        }
      }
      return result;
    });
    for (const factory of factories) {
      const context = factory.params[0];
      if (context?.type !== "Identifier") continue;
      const pending = [factory.body];
      while (pending.length) {
        const node = pending.pop();
        // An inner parameter can use the same name without referring to the
        // Turbopack context supplied to this factory.
        if ((node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression"
          || node.type === "FunctionDeclaration") && node.params.some((p: any) => p.name === context.name)) continue;
        if (node.type === "CatchClause" && node.param?.name === context.name) continue;
        if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
          const receiver = node.callee.object;
          const method = memberName(node.callee);
          const id = node.arguments[0]?.value;
          let kind: External["kind"] | undefined;
          if (receiver.type === "Identifier" && receiver.name === context.name) {
            if (method === "x") kind = "require-call";
            else if (method === "y") kind = "dynamic-import";
          } else if (method === "resolve" && memberName(receiver) === "x"
            && receiver.object.type === "Identifier" && receiver.object.name === context.name) {
            kind = "require-resolve";
          }
          if (kind && typeof id === "string") result.push({ id, importer, kind });
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) {
            for (const item of value) if (item && typeof item.type === "string") pending.push(item);
          } else if (value && typeof value === "object" && "type" in value) {
            pending.push(value);
          }
        }
      }
    }
  }
  return result;
}

function runtimePath(ctx: BuildContext, file: string): string {
  const dist = path.relative(ctx.distDir, file);
  if (!dist.startsWith("..") && !path.isAbsolute(dist)) return path.posix.join(".next", dist.split(path.sep).join("/"));
  const parts = file.split(path.sep);
  const index = parts.lastIndexOf("node_modules");
  if (index >= 0 && parts[index + 1] !== ".pnpm") return path.posix.join("node_modules", ...parts.slice(index + 1));
  const project = path.relative(ctx.projectDir, file);
  if (!project.startsWith("..") && !path.isAbsolute(project)) return project.split(path.sep).join("/");
  throw new Error(`Turbopack external is outside the artifact namespace: ${file}`);
}

async function graphSource(ctx: BuildContext, build: PluginBuild): Promise<NodeGraph> {
  const files = chunkFiles(path.join(ctx.distDir, "server", "chunks"));
  const imports = new Map<string, ImportBinding>();
  const bindings = new Map<string, ResolveResult>();
  const resolutions = new Map<string, { external?: string; file?: string }>();
  for (const external of externals(ctx, files)) {
    // The chunk's static require thunk already uses the build's dependency policy.
    if (external.kind === "require-call") continue;
    const resolved = await build.resolve(external.id, {
      importer: external.importer,
      resolveDir: path.dirname(external.importer),
      kind: external.kind,
    });
    if (resolved.errors.length || !resolved.path) {
      throw new Error(`Cannot statically link Turbopack external ${external.id} from ${external.importer}`);
    }
    if (external.kind === "dynamic-import") {
      const previous = imports.get(external.id);
      const identity = (value: ResolveResult) => [value.path, value.namespace, value.external, value.suffix];
      if (previous !== undefined && JSON.stringify(identity(previous.resolved)) !== JSON.stringify(identity(resolved))) {
        throw new Error(`Turbopack external has conflicting build resolutions: ${external.id}`);
      }
      if (previous === undefined) {
        const specifier = `brrrd:turbopack-import:${imports.size}`;
        imports.set(external.id, { specifier, resolved });
        bindings.set(specifier, resolved);
      }
    } else {
      const target = resolved.external
        ? { external: resolved.path }
        : { file: runtimePath(ctx, resolved.path) };
      const previous = resolutions.get(external.id);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(target)) {
        throw new Error(`Turbopack external has conflicting build resolutions: ${external.id}`);
      }
      resolutions.set(external.id, target);
    }
  }
  const chunks = files.map((file) => {
    const id = path.relative(ctx.distDir, file).split(path.sep).join("/");
    return `[${JSON.stringify(id)}]: () => require(${JSON.stringify(file)})`;
  });
  const asyncImports = [...imports].map(([id, binding]) => `[${JSON.stringify(id)}]: () => import(${JSON.stringify(binding.specifier)})`);
  return { bindings, contents: `
const path = require('node:path');
const chunks = Object.assign(Object.create(null), {${chunks.join(",\n")}});
const imports = Object.assign(Object.create(null), {${asyncImports.join(",\n")}});
const resolutions = Object.assign(Object.create(null), ${JSON.stringify(Object.fromEntries(resolutions))});
function declared(table, id, kind) {
  if (!Object.prototype.hasOwnProperty.call(table, id)) throw new Error('Undeclared Turbopack ' + kind + ': ' + id);
  return table[id];
}
exports.load = id => declared(chunks, id, 'chunk')();
exports.importExternal = id => declared(imports, id, 'import')();
exports.resolveExternal = (id, root, options) => {
  if (options !== undefined) throw new Error('Turbopack require.resolve options are not part of the build graph');
  const target = declared(resolutions, id, 'resolution');
  return target.external ?? path.resolve(root, target.file);
};
` };
}

function connectRuntime(source: string): string {
  let patched = source.replace(RUNTIME_ROOT_RE,
    "const RUNTIME_ROOT = globalThis.__brrrd_turbopack_runtime_root || path.resolve(__filename, relativePathToRuntimeRoot);");
  if (patched === source) throw new Error("failed to patch Turbopack server runtime root");
  const rooted = patched;
  patched = patched.replace(ABSOLUTE_ROOT_RE,
    "const ABSOLUTE_ROOT = globalThis.__brrrd_turbopack_dist_root || path.resolve(__filename, relativePathToDistRoot);");
  if (patched === rooted) throw new Error("failed to patch Turbopack server runtime root");
  // Both production chunk loaders consume the same lazy graph. Asset paths
  // retain their admitted filesystem roots.
  const chunkRead = /const resolved = path\.resolve\(RUNTIME_ROOT, chunkPath\);\s*(?:\/\/[^\n]*\n\s*)*const chunkModules = require\(resolved\);/g;
  const count = [...patched.matchAll(chunkRead)].length;
  if (source.includes("function loadRuntimeChunkPath(") && count !== 2) {
    throw new Error("unsupported Turbopack Node chunk loader source");
  }
  patched = patched.replace(chunkRead, "const chunkModules = __brrrdNodeGraph.load(chunkPath);");
  patched = patched.replace("raw = await import(id);", "raw = await __brrrdNodeGraph.importExternal(id);");
  patched = patched.replace("return require.resolve(id, options);", "return __brrrdNodeGraph.resolveExternal(id, ABSOLUTE_ROOT, options);");
  return `const __brrrdNodeGraph = require(${JSON.stringify(GRAPH)});\n${patched}`;
}

function createTurbopackServerRuntimePlugin(ctx: BuildContext): Plugin {
  return {
    name: "brrrd-turbopack-server-runtime",
    setup(build) {
      let graph: Promise<NodeGraph> | undefined;
      const nodeGraph = () => graph ??= graphSource(ctx, build);
      build.onResolve({ filter: /^brrrd:turbopack-node-graph$/ }, () => ({ path: GRAPH, namespace: "brrrd-node-graph" }));
      build.onResolve({ filter: /^brrrd:turbopack-import:/, namespace: "brrrd-node-graph" }, async (args) => {
        // Keep the decision made by the existing resolver in the source chunk's
        // context, including intentional runtime externals and optional imports.
        const resolved = (await nodeGraph()).bindings.get(args.path);
        if (!resolved) return { errors: [{ text: `Undeclared Turbopack import binding: ${args.path}` }] };
        return resolved;
      });
      build.onLoad({ filter: /.*/, namespace: "brrrd-node-graph" }, async () => ({
        contents: (await nodeGraph()).contents, loader: "js", resolveDir: ctx.projectDir,
      }));
      build.onLoad({ filter: RUNTIME_RE }, (args) => ({
        contents: connectRuntime(fs.readFileSync(args.path, "utf8")),
        loader: "js", resolveDir: path.dirname(args.path),
      }));
    },
  };
}

export const turbopackServerPolicy: CompatibilityPolicy = {
  name: "turbopack-server-runtime",
  plugins: (ctx) => [createTurbopackServerRuntimePlugin(ctx)],
};
