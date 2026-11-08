import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundler = process.argv[2] ?? "turbopack";
assert.ok(["webpack", "turbopack"].includes(bundler));
const evidence = path.join(root, "target/next-runtime-smoke", bundler);
const headline = "brrrd 0.2.x runs on the Node runtime only; Edge runtime is not supported.";
const results = [];

function write(projectDir, name, source) {
  const file = path.join(projectDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

function fixture(name) {
  const projectDir = path.join(evidence, name);
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(projectDir, "node_modules"), { recursive: true });
  const nextRequire = createRequire(require.resolve("next/package.json"));
  const dependencies = {};
  for (const name of ["next", "react", "react-dom"]) {
    const packageFile = nextRequire.resolve(`${name}/package.json`);
    fs.symlinkSync(path.dirname(packageFile), path.join(projectDir, "node_modules", name), "dir");
    dependencies[name] = JSON.parse(fs.readFileSync(packageFile, "utf8")).version;
  }
  write(projectDir, "package.json", JSON.stringify({ name: `brrrd-runtime-${name}`, private: true, dependencies }));
  write(projectDir, "next.config.mjs", `export default ${JSON.stringify({
    adapterPath: path.join(root, "dist/index.js"),
    outputFileTracingRoot: root,
    turbopack: { root },
    typescript: { ignoreBuildErrors: true },
    experimental: { cpus: 2 },
  })};`);
  write(projectDir, "app/layout.jsx", "export default function Layout({ children }) { return <html><body>{children}</body></html>; }");
  write(projectDir, "app/page.jsx", "export default function Page() { return <main>Node runtime</main>; }");
  return projectDir;
}

function build(projectDir) {
  const result = spawnSync(process.execPath, [require.resolve("next/dist/bin/next"), "build", `--${bundler}`], {
    cwd: projectDir,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  fs.writeFileSync(`${projectDir}.log`, log);
  if (result.error) throw result.error;
  return { result, log };
}

function validateContract(projectDir) {
  // These are every validate_next_contract predicate in brrrd's pinned
  // workerd profile. Optional BRRRD_NEXT_PACKAGE_VALIDATOR calls the real
  // Rust validate_next_package (which also calls validate_next_contract).
  const outDir = path.join(projectDir, "dist/brrrd");
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 6);
  assert.equal(manifest.execution.abi, "workerd-node-v1");
  assert.equal(manifest.build.nextVersion, "16.4.3");
  assert.equal(manifest.middleware.moduleFormat, "node");
  assert.equal(manifest.edgeFunctions, undefined);
  assert.ok(manifest.routes.every((route) => route.runtime === "nodejs"));
  assert.ok(manifest.routes.every((route) => !(route.ppr && route.type === "prerender")));
  assert.equal(manifest.appBundle, "bundles/app.js");
  assert.equal(manifest.runtimeDir, "runtime");
  assert.ok(!manifest.artifacts.some((artifact) => artifact.kind === "edge-function"));
  if (process.env.BRRRD_NEXT_PACKAGE_VALIDATOR) {
    const result = spawnSync(process.env.BRRRD_NEXT_PACKAGE_VALIDATOR, [outDir], { encoding: "utf8" });
    fs.writeFileSync(`${projectDir}.package-validation.log`, `${result.stdout ?? ""}${result.stderr ?? ""}`);
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `validate_next_package failed: ${result.stderr}`);
  }
}

{
  const projectDir = fixture("reject-edge");
  write(projectDir, "app/api/app-edge/route.js", "export const runtime = 'edge'; export function GET() { return Response.json({ edge: true }); }");
  write(projectDir, "app/inherited-edge/layout.jsx", "export const runtime = 'edge'; export default function Layout({children}) { return children; }");
  write(projectDir, "app/inherited-edge/page.jsx", "export const dynamic = 'force-dynamic'; export default function Page() { return <p>Inherited edge</p>; }");
  write(projectDir, "pages/edge-page.jsx", "export const config = { runtime: 'experimental-edge' }; export default function Page() { return <p>Edge page</p>; }");
  write(projectDir, "pages/api/pages-edge.js", "export const config = { runtime: 'edge' }; export default function handler(request) { return Response.json({ edge: true }); }");
  write(projectDir, "middleware.ts", "import { NextResponse } from 'next/server'; export function middleware() { return NextResponse.next(); }");
  const { result, log } = build(projectDir);
  assert.notEqual(result.status, 0, "Edge build must fail");
  assert.equal(log.split(headline).length - 1, 1, "All Edge diagnostics must be in one error");
  for (const pattern of [
    /App Router route .*app-edge/,
    /App Router page .*inherited-edge/,
    /Pages Router page .*edge-page/,
    /Pages Router Edge API .*pages-edge.*\(req, res\)/,
    /Edge middleware .*proxy\.ts.*config\.runtime = 'nodejs'/,
  ]) assert.match(log, pattern);
  assert.equal(fs.existsSync(path.join(projectDir, "dist/brrrd")), false);
  results.push({ fixture: "reject-edge", status: result.status, headlineCount: 1, packageExists: false });
  console.log(`${bundler}: rejected all Edge kinds in one error before packaging`);
}

for (const convention of ["middleware", "proxy"]) {
  const projectDir = fixture(`node-${convention}`);
  write(projectDir, "app/api/node/route.js", "export function GET() { return Response.json({ runtime: process.env.NEXT_RUNTIME }); }");
  write(projectDir, `${convention}.ts`, `import { NextResponse } from 'next/server';
    export function ${convention}() { return NextResponse.next(); }
    export const config = { ${convention === "middleware" ? "runtime: 'nodejs'," : ""} matcher: '/api/:path*' };`);
  const { result, log } = build(projectDir);
  assert.equal(result.status, 0, `Node ${convention} build failed; see ${projectDir}.log`);
  assert.equal(log.includes(headline), false);
  validateContract(projectDir);
  results.push({ fixture: `node-${convention}`, status: result.status, contract: "passed", packageValidator: Boolean(process.env.BRRRD_NEXT_PACKAGE_VALIDATOR) });
  console.log(`${bundler}: Node ${convention}.ts package passed contract checks`);
}

fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify({ nextVersion: require("next/package.json").version, bundler, results }, null, 2));
