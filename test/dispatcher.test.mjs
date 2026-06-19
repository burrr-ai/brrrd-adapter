import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { bundleAppHandler } from "../dist/bundler.js";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `brrrd-adapter-${name}-`));
}

function res() {
  return {
    body: "",
    ended: false,
    statusCode: 200,
    end(chunk = "") {
      this.body = String(chunk);
      this.ended = true;
    },
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
  };
}

test("dispatcher resolves async webpack route module exports before calling handler", async () => {
  const root = tempDir("dispatcher");
  const syncRoute = path.join(root, "sync-route.mjs");
  const asyncRoute = path.join(root, "async-route.cjs");

  fs.writeFileSync(
    syncRoute,
    "export function handler(_req, res) { res.end('sync'); }\n",
    "utf8",
  );
  fs.writeFileSync(
    asyncRoute,
    "module.exports = Promise.resolve({ handler(_req, res) { res.end('async'); } });\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [
      { id: "sync", filePath: syncRoute },
      { id: "async", filePath: asyncRoute },
    ],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));

  const syncRes = res();
  await dispatch("sync", { headers: { host: "example.test" } }, syncRes);
  assert.equal(syncRes.body, "sync");

  const asyncRes = res();
  await dispatch("async", { headers: { host: "example.test" } }, asyncRes);
  assert.equal(asyncRes.body, "async");
});

test("dispatcher loads only the requested route module", async () => {
  const root = tempDir("dispatcher-lazy-route");
  const healthyRoute = path.join(root, "healthy-route.mjs");
  const brokenRoute = path.join(root, "broken-route.mjs");

  fs.writeFileSync(
    healthyRoute,
    "export function handler(_req, res) { res.end('healthy'); }\n",
    "utf8",
  );
  fs.writeFileSync(
    brokenRoute,
    "throw new ReferenceError('self is not defined');\nexport function handler() {}\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [
      { id: "healthy", filePath: healthyRoute },
      { id: "broken", filePath: brokenRoute },
    ],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));

  const healthyRes = res();
  await dispatch("healthy", { headers: { host: "example.test" } }, healthyRes);
  assert.equal(healthyRes.body, "healthy");

  await assert.rejects(
    dispatch("broken", { headers: { host: "example.test" } }, res()),
    /self is not defined/,
  );
});

test("dispatcher bundling tolerates missing Next optional runtime dependencies", async () => {
  const root = tempDir("dispatcher-optional-runtime-dep");
  const healthyRoute = path.join(root, "healthy-route.mjs");
  const optionalRoute = path.join(root, "optional-route.cjs");

  fs.writeFileSync(
    healthyRoute,
    "export function handler(_req, res) { res.end('healthy'); }\n",
    "utf8",
  );
  fs.writeFileSync(
    optionalRoute,
    "const critters = require('critters');\nmodule.exports = { handler(_req, res) { res.end(String(critters)); } };\n",
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [
      { id: "healthy", filePath: healthyRoute },
      { id: "optional", filePath: optionalRoute },
    ],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));

  const healthyRes = res();
  await dispatch("healthy", { headers: { host: "example.test" } }, healthyRes);
  assert.equal(healthyRes.body, "healthy");

  await assert.rejects(
    dispatch("optional", { headers: { host: "example.test" } }, res()),
    (err) => {
      assert.match(err.message, /Cannot find module 'critters'/);
      assert.equal(err.code, "MODULE_NOT_FOUND");
      return true;
    },
  );
});

test("dispatcher supplies Next-compatible no-op OpenTelemetry API", async () => {
  const root = tempDir("dispatcher-otel");
  const otelRoute = path.join(root, "otel-route.cjs");

  fs.writeFileSync(
    otelRoute,
    `
const { trace, context } = require('@opentelemetry/api');

module.exports = {
  handler(_req, res) {
    const provider = trace.getTracerProvider();
    const tracer = provider.getTracer('next.js', '0.0.1');
    const result = tracer.startActiveSpan('render', {}, context.active(), (span) => {
      span.setAttribute('next.span_name', 'render');
      return 'otel-ok';
    });
    res.end(result);
  },
};
`,
    "utf8",
  );

  const bundlePath = await bundleAppHandler(
    [{ id: "otel", filePath: otelRoute }],
    {
      projectDir: root,
      distDir: path.join(root, ".next"),
      outDir: path.join(root, "out"),
      buildId: "test-build",
    },
  );

  const { default: dispatch } = await import(pathToFileURL(bundlePath));

  const otelRes = res();
  await dispatch("otel", { headers: { host: "example.test" } }, otelRes);
  assert.equal(otelRes.body, "otel-ok");
});
