import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { onBuildComplete } from "../dist/build.js";
import { assertNodeRuntime } from "../dist/runtime-validator.js";

const headline = "brrrd 0.2.x runs on the Node runtime only; Edge runtime is not supported.";

function context(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-node-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    projectDir: root, repoRoot: root, distDir: path.join(root, ".next"),
    config: {}, nextVersion: "16.4.3", buildId: "node-only",
    outputs: {
      pages: [], appPages: [], appRoutes: [], pagesApi: [],
      prerenders: [], staticFiles: [],
    },
  };
}

function edge(id, type, runtime = "edge") {
  return { id, pathname: `/${id}`, sourcePage: `/${id}`, type, runtime };
}

test("rejects every Next Edge output in one error before creating a deployment package", async (t) => {
  const ctx = context(t);
  ctx.outputs.appPages = [edge("inherited-page", "APP_PAGE")];
  ctx.outputs.appRoutes = [edge("app-api", "APP_ROUTE")];
  ctx.outputs.pages = [edge("pages-page", "PAGES", "experimental-edge")];
  ctx.outputs.pagesApi = [edge("pages-api", "PAGES_API")];
  ctx.outputs.middleware = edge("middleware", "MIDDLEWARE");
  await assert.rejects(onBuildComplete(ctx), (error) => {
    const lines = error.message.split("\n");
    assert.equal(lines[0], headline);
    assert.equal(lines.length, 6);
    assert.match(error.message, /App Router page .*inherited-page.*inherited layout config/);
    assert.match(error.message, /App Router route .*app-api.*set it to 'nodejs'/);
    assert.match(error.message, /Pages Router page .*pages-page.*Remove the Edge\/experimental-edge runtime declaration/);
    assert.match(error.message, /Pages Router Edge API .*pages-api.*\(req, res\).*removing the runtime declaration alone is not enough/);
    assert.match(error.message, /Edge middleware .*middleware.*proxy\.ts.*config\.runtime = 'nodejs'/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(ctx.projectDir, "dist")), false);
});

test("complete edgeRuntime metadata cannot bypass Node admission or delete an existing package", async (t) => {
  const ctx = context(t);
  ctx.outputs.appRoutes = [{
    ...edge("complete-edge", "APP_ROUTE", "nodejs"),
    edgeRuntime: { modulePath: "/missing.js", entryKey: "middleware_edge", handlerExport: "handler" },
  }];
  const outDir = path.join(ctx.projectDir, "dist/brrrd");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "sentinel"), "previous package");
  await assert.rejects(onBuildComplete(ctx), { message: new RegExp(headline.replaceAll(".", "\\.")) });
  assert.deepEqual(fs.readdirSync(outDir), ["sentinel"]);
  assert.equal(fs.readFileSync(path.join(outDir, "sentinel"), "utf8"), "previous package");
});

test("edgeRuntime alone identifies Edge even when Next omits runtime", (t) => {
  const ctx = context(t);
  ctx.outputs.appRoutes = [{
    id: "edge-metadata-only", pathname: "/route", type: "APP_ROUTE",
    edgeRuntime: { modulePath: "/missing.js", entryKey: "edge", handlerExport: "handler" },
  }];
  assert.throws(() => assertNodeRuntime(ctx), /App Router route .*edge-metadata-only/);
});

test("unknown output kinds report the id without guessing from route or source paths", (t) => {
  const ctx = context(t);
  ctx.outputs.appPages = [{ ...edge("unknown-id", "FUTURE"), pathname: "/api/not-evidence", sourcePage: "/app/middleware" }];
  assert.throws(() => assertNodeRuntime(ctx), (error) => {
    assert.equal(error.message, `${headline}\n  - Edge output [unknown-id]: Configure this output to use the Node runtime.`);
    return true;
  });
});

test("legacy Edge middleware metadata joins API errors without reading chunks or user source", (t) => {
  const ctx = context(t);
  ctx.outputs.pagesApi = [edge("edge-api", "PAGES_API")];
  fs.mkdirSync(path.join(ctx.distDir, "server"), { recursive: true });
  fs.writeFileSync(path.join(ctx.distDir, "server/middleware-manifest.json"), JSON.stringify({
    middleware: { "/": { files: ["missing.js"] }, "/admin": { files: ["also-missing.js"] } },
  }));
  assert.throws(() => assertNodeRuntime(ctx), (error) => {
    assert.equal(error.message.split("\n").length, 4);
    assert.match(error.message, /Pages Router Edge API/);
    assert.match(error.message, /Edge middleware \/ \[\/\]/);
    assert.match(error.message, /Edge middleware \/admin \[\/admin\]/);
    return true;
  });
});

test("Node middleware output is authoritative and edge library asset names remain supported", (t) => {
  const ctx = context(t);
  ctx.outputs.appRoutes = [{ id: "og", pathname: "/og", runtime: "nodejs", assets: { og: "index.edge.js" } }];
  ctx.outputs.middleware = { id: "node-middleware", pathname: "/middleware", runtime: "nodejs" };
  assert.doesNotThrow(() => assertNodeRuntime(ctx));
});

test("middleware without a Node output runtime is rejected", (t) => {
  const ctx = context(t);
  ctx.outputs.middleware = { id: "untyped-middleware", pathname: "/middleware" };
  assert.throws(() => assertNodeRuntime(ctx), /Edge middleware .*config\.runtime = 'nodejs'/);
});
