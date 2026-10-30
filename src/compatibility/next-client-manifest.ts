import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import type { BuildContext } from "../types.js";
import type { CompatibilityPolicy } from "./types.js";

const require = createRequire(import.meta.url);
export const CLIENT_DATA_SUFFIX = ".brrrd-client-data.json";
const LOADER_RE = /[\\/]next[\\/]dist[\\/]server[\\/]load-manifest\.external\.js$/;
const VM_CALL = "(0, _vm.runInNewContext)(content, contextObject);";

function nextModule(name: string, ctx: BuildContext): string {
  try { return require.resolve(name, { paths: [ctx.projectDir, ctx.distDir] }); }
  catch { return require.resolve(name); }
}

// Validate the pinned Next emitter's static data grammar. This does not evaluate JS;
// the actual value below is produced by Next's original evalManifest in a real Node VM.
type Node = { type: string; [key: string]: any };
function manifestRoot(node: Node): boolean {
  return node?.type === "MemberExpression" && !node.computed
    && node.object?.type === "Identifier" && node.object.name === "globalThis"
    && node.property?.name === "__RSC_MANIFEST";
}
function literalData(node: Node): boolean {
  if (!node) return false;
  if (node.type === "Literal") return node.value === null || ["string", "boolean"].includes(typeof node.value)
    || (typeof node.value === "number" && Number.isFinite(node.value));
  if (node.type === "UnaryExpression") return node.operator === "-" && node.argument?.type === "Literal"
    && typeof node.argument.value === "number" && Number.isFinite(node.argument.value);
  if (node.type === "ArrayExpression") return node.elements.every(literalData);
  return node.type === "ObjectExpression" && node.properties.every((property: Node) =>
    property.type === "Property" && property.kind === "init" && !property.method && !property.computed
    && property.key?.type === "Literal" && typeof property.key.value === "string"
    && property.key.value !== "__proto__" && literalData(property.value));
}
export function assertStaticClientManifest(source: string, parse: (source: string, options: object) => Node): void {
  const program = parse(source, { ecmaVersion: 2020 });
  const statements = program.body;
  const first = statements[0]?.expression, second = statements[1]?.expression;
  if (statements.length !== 2 || !statements.every((statement: Node) => statement.type === "ExpressionStatement")
    || first?.type !== "AssignmentExpression" || first.operator !== "=" || !manifestRoot(first.left)
    || first.right?.type !== "LogicalExpression" || first.right.operator !== "||"
    || !manifestRoot(first.right.left) || first.right.right?.type !== "ObjectExpression" || first.right.right.properties.length
    || second?.type !== "AssignmentExpression" || second.operator !== "="
    || second.left?.type !== "MemberExpression" || !second.left.computed || !manifestRoot(second.left.object)
    || second.left.property?.type !== "Literal" || typeof second.left.property.value !== "string"
    || !literalData(second.right)) {
    throw new Error("unsupported Next client manifest: runtime/context-dependent JavaScript is not a static artifact");
  }
}
function files(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(root, entry.name);
    return entry.isDirectory() ? files(name) : entry.isFile() ? [name] : [];
  });
}
export function emitClientManifestData(ctx: BuildContext): Record<string, string> {
  const { parse } = require(nextModule("next/dist/compiled/acorn", ctx));
  const { evalManifest } = require(nextModule("next/dist/server/load-manifest.external", ctx));
  const { CLIENT_REFERENCE_MANIFEST } = require(nextModule("next/dist/shared/lib/constants", ctx));
  const records: Record<string, string> = {};
  for (const sourcePath of files(path.join(ctx.distDir, "server", "app"))) {
    if (!sourcePath.endsWith(`_${CLIENT_REFERENCE_MANIFEST}.js`)) continue;
    const source = fs.readFileSync(sourcePath, "utf8");
    assertStaticClientManifest(source, parse);
    const original = evalManifest(sourcePath, false, new Map());
    if (Object.keys(original).some(key => !["process", "__RSC_MANIFEST"].includes(key)) || !original.__RSC_MANIFEST) {
      throw new Error(`unsupported Next client manifest context: ${sourcePath}`);
    }
    const relative = path.relative(ctx.distDir, sourcePath).split(path.sep).join("/");
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const target = path.join(ctx.outDir, "runtime", ".next", relative + CLIENT_DATA_SUFFIX);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ version: 1, sourceSha256,
      value: { __RSC_MANIFEST: original.__RSC_MANIFEST } }) + "\n");
    records[relative] = sourceSha256;
  }
  return records;
}

export function adaptManifestLoader(source: string, records: Record<string, string>): string {
  if (createHash("sha256").update(source).digest("hex") !== "6e88909558245f1e1e95d97de869a9210f58995e4e19fdba62c25adf8e43d826") {
    throw new Error("unsupported Next16.4.3 manifest loader source pin");
  }
  if (source.split(VM_CALL).length !== 2) throw new Error("unsupported Next manifest loader source: VM call guard changed");
  // Only replace the actual VM operation. Original reads/missing/cache/freeze/clear remain intact.
  const call = `if (!brrrdStaticClientManifest(path, content, contextObject)) { ${VM_CALL} }`;
  return source.replace(VM_CALL, call) + `
function brrrdStaticClientManifest(path, content, contextObject) {
  const records = ${JSON.stringify(records)};
  const paths = require('node:path');
  const distRoot = paths.resolve(__dirname, '../runtime/.next');
  const relative = paths.relative(distRoot, paths.resolve(path));
  if (relative === '..' || relative.startsWith('..' + paths.sep) || paths.isAbsolute(relative)) return false;
  const key = relative.split(paths.sep).join('/');
  if (!Object.prototype.hasOwnProperty.call(records, key)) return false;
  const actual = require('node:crypto').createHash('sha256').update(content).digest('hex');
  if (actual !== records[key]) throw new Error('compiled Next client manifest source changed: ' + path);
  const record = loadManifest(path + ${JSON.stringify(CLIENT_DATA_SUFFIX)}, false);
  if (record.version !== 1 || record.sourceSha256 !== actual
    || !record.value || Object.keys(record.value).some(key => key !== '__RSC_MANIFEST')
    || !record.value.__RSC_MANIFEST) throw new Error('invalid compiled Next client manifest: ' + path);
  Object.assign(contextObject, record.value);
  return true;
}
`;
}

export const nextClientManifestPolicy: CompatibilityPolicy = {
  name: "next-static-client-manifest-data",
  plugins(ctx) {
    const records = emitClientManifestData(ctx);
    return [{ name: "brrrd-next-static-client-manifest-data", setup(build) {
      build.onLoad({ filter: LOADER_RE }, args => ({
        contents: adaptManifestLoader(fs.readFileSync(args.path, "utf8"), records),
        loader: "js", resolveDir: path.dirname(args.path),
      }));
    } }];
  },
};
