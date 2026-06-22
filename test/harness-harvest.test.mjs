import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  buildHarvestTargets,
  buildTargets,
  createSummary,
  diagnosticFailureTextForLocalHarnessArtifacts,
  extractFailureHints,
  extractFailedFixtures,
  extractLocalHarnessArtifactDirs,
  failureDigestForTarget,
  parseArgs,
  parsePrintedTests,
  resultCollisionKey,
  shouldExitForDeferredTargets,
  suggestBucket,
  takeNextRunnableTarget,
  updateFailureLedger,
} from "../scripts/harness-harvest.mjs";

test("harvest parseArgs expands groups and bundlers", () => {
	const options = parseArgs([
	  "--groups",
	  "6/64,7/64",
	  "--bundlers",
	  "webpack,turbopack",
	  "--parallel",
	  "3",
	  "--list-parallel",
	  "2",
	  "--concurrency",
	  "2",
	  "--timeout-ms",
	  "12345",
    "--defer-after-ms",
    "300000",
    "--max-deferred-running",
    "2",
    "--cleanup-target-artifacts",
    "passed",
    "--list-timeout-ms",
    "23456",
	  "--name",
	  "wide",
	  "--expand-fixtures",
	  "--capture-context",
	], {});

	assert.deepEqual(options.groups, ["6/64", "7/64"]);
	assert.deepEqual(options.bundlers, ["webpack", "turbopack"]);
	assert.equal(options.parallel, "3");
	assert.equal(options.listParallel, "2");
	assert.equal(options.concurrency, "2");
	assert.equal(options.timeoutMs, "12345");
  assert.equal(options.deferAfterMs, "300000");
  assert.equal(options.maxDeferredRunning, "2");
  assert.equal(options.cleanupTargetArtifacts, "passed");
  assert.equal(options.listTimeoutMs, "23456");
	assert.equal(options.slowMs, "600000");
	assert.equal(options.name, "wide");
	assert.equal(options.expandFixtures, true);
	assert.equal(options.captureContext, true);
});

test("harvest parseArgs accepts a slow target threshold", () => {
  const options = parseArgs([
    "--groups",
    "6/64",
    "--slow-ms",
    "42",
  ], {});

  assert.equal(options.slowMs, "42");
});

test("harvest parseArgs accepts direct fixture targets without groups", () => {
  const options = parseArgs([
    "--fixtures",
    "test/e2e/a/a.test.ts,test/e2e/b/b.test.ts",
    "--bundlers",
    "webpack",
    "--name",
    "direct",
  ], {});

  assert.deepEqual(options.groups, []);
  assert.deepEqual(options.fixtures, [
    "test/e2e/a/a.test.ts",
    "test/e2e/b/b.test.ts",
  ]);
  assert.equal(options.name, "direct");
});

test("harvest parseArgs configures persistent failure ledger", () => {
  const options = parseArgs([
    "--groups",
    "6/64",
    "--ledger-file",
    "/tmp/brrrd-ledger.jsonl",
  ], {});

  assert.equal(options.updateLedger, true);
  assert.equal(options.ledgerFile, "/tmp/brrrd-ledger.jsonl");

  const disabled = parseArgs([
    "--groups",
    "6/64",
    "--no-ledger",
  ], {});

  assert.equal(disabled.updateLedger, false);
});

test("harvest rejects unsupported bundlers and missing groups", () => {
  assert.throws(
    () => parseArgs(["--bundlers", "webpack"], {}),
    /--groups or --fixtures is required/,
  );
  assert.throws(
    () => parseArgs(["--groups", "1/64", "--bundlers", "magic"], {}),
    /unsupported bundler: magic/,
  );
  assert.throws(
    () => parseArgs(["--groups", "1/64", "--defer-after-ms", "-1"], {}),
    /--defer-after-ms must be a non-negative integer/,
  );
  assert.throws(
    () => parseArgs(["--groups", "1/64", "--cleanup-target-artifacts", "sometimes"], {}),
    /--cleanup-target-artifacts must be never, passed, or always/,
  );
});

test("harvest buildTargets creates a matrix in bundler-major order", () => {
  const targets = buildTargets(parseArgs([
    "--groups",
    "6/64,7/64",
    "--bundlers",
    "webpack,next-default",
    "--name",
    "candidate",
  ], {}));

  assert.deepEqual(targets.map(({ kind, bundler, group }) => ({ kind, bundler, group })), [
    { kind: "group", bundler: "webpack", group: "6/64" },
    { kind: "group", bundler: "webpack", group: "7/64" },
    { kind: "group", bundler: "next-default", group: "6/64" },
    { kind: "group", bundler: "next-default", group: "7/64" },
  ]);
  assert.match(targets[0].name, /^candidate-webpack-6-64-[a-f0-9]{8}$/);
});

test("harvest buildTargets creates direct fixture targets", () => {
  const targets = buildTargets(parseArgs([
    "--fixtures",
    "test/e2e/a/a.test.ts,test/e2e/b/b.test.ts",
    "--bundlers",
    "webpack,next-default",
    "--name",
    "direct",
  ], {}));

  assert.deepEqual(
    targets.map(({ kind, bundler, group, fixture }) => ({ kind, bundler, group, fixture })),
    [
      {
        kind: "fixture",
        bundler: "webpack",
        group: "fixture",
        fixture: "test/e2e/a/a.test.ts",
      },
      {
        kind: "fixture",
        bundler: "webpack",
        group: "fixture",
        fixture: "test/e2e/b/b.test.ts",
      },
      {
        kind: "fixture",
        bundler: "next-default",
        group: "fixture",
        fixture: "test/e2e/a/a.test.ts",
      },
      {
        kind: "fixture",
        bundler: "next-default",
        group: "fixture",
        fixture: "test/e2e/b/b.test.ts",
      },
    ],
  );
  assert.match(targets[0].name, /^direct-webpack-fixture-test-e2e-a-a.test.ts-[a-f0-9]{8}$/);
});

test("harvest parses Next --print-tests output into fixture paths", () => {
  assert.deepEqual(parsePrintedTests(`
Some setup line
Running tests:
test/e2e/a/a.test.ts
test/e2e/b/b.test.tsx
test/e2e/a/a.test.ts
total: 2
`), [
    "test/e2e/a/a.test.ts",
    "test/e2e/b/b.test.tsx",
  ]);
});

test("harvest expands shard groups into fixture targets when requested", async () => {
  const options = parseArgs([
    "--groups",
    "6/64,7/64",
    "--bundlers",
    "webpack,turbopack",
    "--name",
    "expanded",
    "--expand-fixtures",
  ], {});
  const targets = await buildHarvestTargets(options, "/tmp/harvest", {
    listGroupFixtures: async ({ bundler, group }) => [
      `test/e2e/${bundler}-${group.replace("/", "-")}/first.test.ts`,
      `test/e2e/${bundler}-${group.replace("/", "-")}/second.test.ts`,
    ],
  });

  assert.equal(targets.length, 8);
  assert.deepEqual(targets.map(({ kind }) => kind), Array(8).fill("fixture"));
	assert.deepEqual(
	  targets.slice(0, 2).map(({ bundler, group, fixture }) => ({ bundler, group, fixture })),
    [
      {
        bundler: "webpack",
        group: "6/64",
        fixture: "test/e2e/webpack-6-64/first.test.ts",
      },
      {
        bundler: "webpack",
        group: "6/64",
        fixture: "test/e2e/webpack-6-64/second.test.ts",
      },
    ],
	);
});

test("harvest expands fixture lists with bounded parallelism", async () => {
	const options = parseArgs([
	  "--groups",
	  "6/64,7/64,8/64",
	  "--bundlers",
	  "webpack",
	  "--name",
	  "expanded",
	  "--expand-fixtures",
	  "--list-parallel",
	  "2",
	], {});
	let active = 0;
	let maxActive = 0;

	const targets = await buildHarvestTargets(options, "/tmp/harvest", {
	  listGroupFixtures: async ({ group }) => {
	    active += 1;
	    maxActive = Math.max(maxActive, active);
	    await new Promise((resolve) => setTimeout(resolve, 5));
	    active -= 1;
	    return [`test/e2e/${group.replace("/", "-")}/first.test.ts`];
	  },
	});

	assert.equal(maxActive, 2);
	assert.deepEqual(targets.map(({ group }) => group), ["6/64", "7/64", "8/64"]);
});

test("harvest direct fixture targets skip shard fixture listing", async () => {
  const options = parseArgs([
    "--fixtures",
    "test/e2e/a/a.test.ts",
    "--bundlers",
    "webpack",
    "--expand-fixtures",
  ], {});

  const targets = await buildHarvestTargets(options, "/tmp/harvest", {
    listGroupFixtures: async () => {
      throw new Error("direct fixture targets should not list shard groups");
    },
  });

  assert.deepEqual(
    targets.map(({ kind, bundler, group, fixture }) => ({ kind, bundler, group, fixture })),
    [{
      kind: "fixture",
      bundler: "webpack",
      group: "fixture",
      fixture: "test/e2e/a/a.test.ts",
    }],
  );
});

test("harvest scheduler avoids concurrent targets that share Next result files", () => {
  const pending = [
    { kind: "group", bundler: "turbopack", group: "6/64", name: "turbopack-6" },
    { kind: "group", bundler: "webpack", group: "7/64", name: "webpack-7" },
  ];
  const running = [
    { kind: "group", bundler: "webpack", group: "6/64", name: "webpack-6" },
  ];

  assert.deepEqual(
    takeNextRunnableTarget(pending, running),
    { kind: "group", bundler: "webpack", group: "7/64", name: "webpack-7" },
  );
  assert.deepEqual(pending, [
    { kind: "group", bundler: "turbopack", group: "6/64", name: "turbopack-6" },
  ]);
  assert.equal(takeNextRunnableTarget(pending, running), null);
});

test("harvest scheduler only blocks matching fixtures after expansion", () => {
  assert.equal(
    resultCollisionKey({
      kind: "fixture",
      bundler: "webpack",
      group: "6/64",
      fixture: "test/e2e/a/a.test.ts",
    }),
    "fixture:test/e2e/a/a.test.ts",
  );

  const pending = [
    {
      kind: "fixture",
      bundler: "turbopack",
      group: "6/64",
      fixture: "test/e2e/a/a.test.ts",
      name: "turbopack-a",
    },
    {
      kind: "fixture",
      bundler: "webpack",
      group: "6/64",
      fixture: "test/e2e/b/b.test.ts",
      name: "webpack-b",
    },
  ];
  const running = [
    {
      kind: "fixture",
      bundler: "webpack",
      group: "6/64",
      fixture: "test/e2e/a/a.test.ts",
      name: "webpack-a",
    },
  ];

  assert.deepEqual(
    takeNextRunnableTarget(pending, running),
    {
      kind: "fixture",
      bundler: "webpack",
      group: "6/64",
      fixture: "test/e2e/b/b.test.ts",
      name: "webpack-b",
    },
  );
});

test("harvest scheduler can finish when only bounded deferred targets remain", () => {
  assert.equal(shouldExitForDeferredTargets({
    pendingCount: 0,
    maxDeferredRunning: 5,
    runningTargets: [
      { name: "slow-a", deferred: true },
      { name: "slow-b", deferred: true },
    ],
  }), true);

  assert.equal(shouldExitForDeferredTargets({
    pendingCount: 1,
    maxDeferredRunning: 5,
    runningTargets: [
      { name: "slow-a", deferred: true },
    ],
  }), false);

  assert.equal(shouldExitForDeferredTargets({
    pendingCount: 0,
    maxDeferredRunning: 1,
    runningTargets: [
      { name: "slow-a", deferred: true },
      { name: "slow-b", deferred: true },
    ],
  }), false);

  assert.equal(shouldExitForDeferredTargets({
    pendingCount: 0,
    maxDeferredRunning: 5,
    runningTargets: [
      { name: "slow-a", deferred: true },
      { name: "active-b", deferred: false },
    ],
  }), false);
});

test("harvest extracts failed fixture inventory from run-tests output", () => {
  const failures = extractFailedFixtures(`
FAIL webpack test/e2e/app-dir/prefetch-true-instant/prefetch-true-instant.test.ts (40.105 s)
test/e2e/app-dir/prefetch-true-instant/prefetch-true-instant.test.ts failed due to Error: failed with code: 1
test/e2e/app-dir/prefetch-true-instant/prefetch-true-instant.test.ts failed to pass within 2 retries
test/e2e/another/another.test.ts failed due to Error: failed with code: 1
`);

  assert.deepEqual(
    failures.map((failure) => failure.fixture),
    [
      "test/e2e/app-dir/prefetch-true-instant/prefetch-true-instant.test.ts",
      "test/e2e/another/another.test.ts",
    ],
  );
  assert.equal(failures[0].messages.length, 3);
});

test("harvest extracts compact failure hints for fixture target bucketing", () => {
  const hints = extractFailureHints(`
[brrrd-harness] build app failed with exit status 1
Error: static prerender HTML served without invoking the handler does not exist: .next/server/pages/base/another-page.html
Expected substring: "This page could not be found."
Received string:    "Not Found"
`);

  assert.deepEqual(hints, [
    "[brrrd-harness] build app failed with exit status 1",
    "Error: static prerender HTML served without invoking the handler does not exist: .next/server/pages/base/another-page.html",
    "Expected substring: \"This page could not be found.\"",
    "Received string:    \"Not Found\"",
  ]);

  assert.deepEqual(extractFailureHints(`
noise
Error: native Node addons (.node) are not supported in brrrd isolates:
  - node_modules/sqlite3/lib/binding/napi-v3-darwin-arm64/node_sqlite3.node
`), [
    "Error: native Node addons (.node) are not supported in brrrd isolates:",
    "- node_modules/sqlite3/lib/binding/napi-v3-darwin-arm64/node_sqlite3.node",
  ]);
});

test("harvest does not synthesize fixture failures from hints after a passing run", () => {
  const target = {
    kind: "fixture",
    fixture: "test/e2e/app-dir/app-prefetch/prefetching.stale-times.test.ts",
  };
  const output = `
PASS webpack test/e2e/app-dir/app-prefetch/prefetching.stale-times.test.ts
○ skipped should not fetch again when a static page was prefetched
`;

  assert.deepEqual(failureDigestForTarget(target, [], output, 0), []);
  assert.deepEqual(failureDigestForTarget(target, [], "Error: real failure", 1), [
    {
      fixture: target.fixture,
      messages: ["Error: real failure"],
    },
  ]);
});

test("harvest extracts local harness artifact directories for cleanup", () => {
  assert.deepEqual(extractLocalHarnessArtifactDirs(`
[brrrd-local-harness] artifacts: /tmp/run-a
noise
[brrrd-local-harness] artifacts: /tmp/run-b
[brrrd-local-harness] artifacts: /tmp/run-a
`), ["/tmp/run-a", "/tmp/run-b"]);
});

test("harvest reads deploy diagnostics for failures without Jest fixture inventory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-harvest-diagnostics-"));
  const log = path.join(
    dir,
    "harness-diagnostics",
    "deploy-failed",
    "digest",
    "adapter-build.log",
  );
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, [
    "Failed to run onBuildComplete from @brrrd/adapter",
    "Error: native Node addons (.node) are not supported in brrrd isolates:",
    "  - node_modules/sqlite3/lib/binding/napi-v3-darwin-arm64/node_sqlite3.node",
    "",
  ].join("\n"));

  const diagnosticText = diagnosticFailureTextForLocalHarnessArtifacts(`
[brrrd-local-harness] artifacts: ${dir}
`);
  assert.match(diagnosticText, /native Node addons/);
  const failures = failureDigestForTarget(
    {
      kind: "fixture",
      fixture: "test/e2e/prerender-native-module.test.ts",
    },
    [],
    diagnosticText,
    1,
  );
  assert.equal(failures[0].fixture, "test/e2e/prerender-native-module.test.ts");
  assert.equal(suggestBucket(failures[0]), "Node/runtime API");
});

test("harvest suggests root-cause buckets from failure inventory", () => {
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/app-dir/prefetch-true-instant/prefetch-true-instant.test.ts",
      messages: ["Expected page text to contain Cached content"],
    }),
    "PPR/instant prefetch",
  );
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/app-dir/segment-cache/metadata/segment-cache-metadata.test.ts",
      messages: ["Expected page text to contain Dynamic Title"],
    }),
    "segment-cache/PPR prefetch",
  );
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/app-dir/partial-prefetching-config/partial-prefetching-config.test.ts",
      messages: ["FAIL webpack test/e2e/app-dir/partial-prefetching-config/partial-prefetching-config.test.ts"],
    }),
    "segment-cache/PPR prefetch",
  );
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/app-dir/interception-route-prefetch-cache/interception-route-prefetch-cache.test.ts",
      messages: ["FAIL webpack test/e2e/app-dir/interception-route-prefetch-cache/interception-route-prefetch-cache.test.ts"],
    }),
    "segment-cache/PPR prefetch",
  );
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/middleware-dynamic-basepath-matcher/test/index.test.ts",
      messages: [
        "static prerender HTML served without invoking the handler does not exist: .next/server/pages/base/another-page.html",
      ],
    }),
    "Pages data route",
  );
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/app-dir/prefetching-not-found/prefetching-not-found.test.ts",
      messages: [
        "Expected substring: \"This page could not be found.\"",
        "Received string:    \"Not Found\"",
      ],
    }),
    "App not-found fallback",
  );
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/app-dir/app-prefetch/prefetching.test.ts",
      messages: [
        "should not unintentionally modify the requested prefetch by escaping the uri encoded query params",
      ],
    }),
    "RSC prefetch URL encoding",
  );
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/app-dir/actions-unrecognized/actions-unrecognized.test.ts",
      messages: [
        "⨯ prefetchInlining",
        "Failed to bundle app handler: Error: Build failed with 1 error:",
        "No loader is configured for \".map\" files: .next/server/chunks/224.js.map",
      ],
    }),
    "bundler output shape",
  );
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/prerender-native-module.test.ts",
      messages: [
        "Failed to run onBuildComplete from @brrrd/adapter",
        "native Node addons (.node) are not supported in brrrd isolates:",
        "node_modules/sqlite3/lib/binding/napi-v3-darwin-arm64/node_sqlite3.node",
      ],
    }),
    "Node/runtime API",
  );
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/middleware-general/test/node-runtime.test.ts",
      messages: ["FAIL webpack test/e2e/middleware-general/test/node-runtime.test.ts", "404: This page could not be found"],
    }),
    "middleware/proxy",
  );
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts",
      messages: ["FAIL webpack test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts", "Received:"],
    }),
    "App root params",
  );
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/dynamic-route-interpolation/index.test.ts",
      messages: ["FAIL webpack test/e2e/dynamic-route-interpolation/index.test.ts", "Expected: \"a\""],
    }),
    "dynamic route interpolation",
  );
  assert.equal(
    suggestBucket({
      fixture: "test/e2e/server-asset-modules/server-asset-modules.test.ts",
      messages: ["FAIL webpack test/e2e/server-asset-modules/server-asset-modules.test.ts", "Expected: 200", "Received: 500"],
    }),
    "server asset modules",
  );
});

test("harvest summary groups failures by bucket and exposes slow targets", () => {
  const summary = createSummary({
    startedAt: "2026-06-20T00:00:00.000Z",
    finishedAt: "2026-06-20T00:01:00.000Z",
    slowMs: 1000,
    now: "2026-06-20T00:01:30.000Z",
	    running: [
	      {
	        kind: "group",
	        bundler: "webpack",
        group: "7/64",
        name: "harvest-webpack-7-64",
        startedAt: "2026-06-20T00:00:30.000Z",
        resultCollisionKey: "group:7/64",
        deferred: true,
        deferredAt: "2026-06-20T00:01:00.000Z",
        deferAfterMs: 30000,
      },
    ],
	    pending: [
	      {
	        kind: "group",
	        bundler: "turbopack",
        group: "7/64",
        name: "harvest-turbopack-7-64",
      },
    ],
	    results: [
	      {
	        kind: "group",
	        bundler: "webpack",
        group: "6/64",
        name: "harvest-webpack-6-64",
        status: 1,
        signal: null,
        elapsedMs: 1500,
        failures: [
          {
            fixture: "test/e2e/app-dir/prefetch-true-instant/prefetch-true-instant.test.ts",
            messages: ["Expected page text to contain Cached content"],
          },
        ],
        stdout: "hidden from summary result details",
        stderr: "hidden from summary result details",
      },
    ],
  });

  assert.equal(summary.status, "fail");
  assert.equal(summary.failureCount, 1);
  assert.deepEqual(summary.buckets, { "PPR/instant prefetch": 1 });
	  assert.deepEqual(summary.slowTargets, [
	    {
	      kind: "group",
	      bundler: "webpack",
      group: "6/64",
      name: "harvest-webpack-6-64",
      elapsedMs: 1500,
    },
  ]);
  assert.equal(summary.failures[0].bucket, "PPR/instant prefetch");
  assert.equal(summary.results[0].stdout, undefined);
  assert.equal(summary.results[0].failures[0].bucket, "PPR/instant prefetch");
  assert.deepEqual(summary.deferredTargets, [
    {
      kind: "group",
      bundler: "webpack",
      group: "7/64",
      name: "harvest-webpack-7-64",
      startedAt: "2026-06-20T00:00:30.000Z",
      deferred: true,
      deferredAt: "2026-06-20T00:01:00.000Z",
      deferAfterMs: 30000,
    },
  ]);
  assert.deepEqual(summary.slowRunningTargets, [
    {
      kind: "group",
      bundler: "webpack",
      group: "7/64",
      name: "harvest-webpack-7-64",
      startedAt: "2026-06-20T00:00:30.000Z",
      deferred: true,
      deferredAt: "2026-06-20T00:01:00.000Z",
      deferAfterMs: 30000,
      elapsedMs: 60000,
    },
  ]);
	  assert.deepEqual(summary.running, [
	    {
	      kind: "group",
	      bundler: "webpack",
      group: "7/64",
      name: "harvest-webpack-7-64",
      startedAt: "2026-06-20T00:00:30.000Z",
      deferred: true,
      deferredAt: "2026-06-20T00:01:00.000Z",
      deferAfterMs: 30000,
    },
  ]);
});

test("harvest summary buckets fixture setup failures from stderr hints", () => {
  const summary = createSummary({
    startedAt: "2026-06-20T00:00:00.000Z",
    finishedAt: "2026-06-20T00:01:00.000Z",
    slowMs: 1000,
    results: [
      {
        kind: "fixture",
        bundler: "webpack",
        group: null,
        fixture: "test/e2e/prerender-native-module.test.ts",
        name: "native-fixture",
        status: 1,
        signal: null,
        elapsedMs: 500,
        failures: [],
        stdout: "",
        stderr: [
          "Error: native Node addons (.node) are not supported in brrrd isolates:",
          "  - node_modules/sqlite3/lib/binding/napi-v3-darwin-arm64/node_sqlite3.node",
        ].join("\n"),
      },
    ],
  });

  assert.equal(summary.failureCount, 1);
  assert.deepEqual(summary.buckets, { "Node/runtime API": 1 });
  assert.equal(summary.failures[0].bucket, "Node/runtime API");
});

test("harvest summary marks interrupted runs as aborted", () => {
  const summary = createSummary({
    startedAt: "2026-06-20T00:00:00.000Z",
    finishedAt: "2026-06-20T00:00:10.000Z",
    slowMs: 1000,
    abortedSignal: "SIGTERM",
	    pending: [
	      { kind: "group", bundler: "turbopack", group: "6/64", name: "turbopack-6" },
    ],
    results: [],
  });

  assert.equal(summary.status, "aborted");
  assert.equal(summary.abortedSignal, "SIGTERM");
  assert.equal(summary.failureCount, 0);
	  assert.deepEqual(summary.pending, [
	    { kind: "group", bundler: "turbopack", group: "6/64", name: "turbopack-6" },
	]);
});

test("harvest summary fails nonzero group targets even without parsed fixture failures", () => {
	const summary = createSummary({
	  startedAt: "2026-06-20T00:00:00.000Z",
	  finishedAt: "2026-06-20T00:01:00.000Z",
	  slowMs: 1000,
	  results: [
	    {
	      kind: "group",
	      bundler: "webpack",
	      group: "13/64",
	      name: "harvest-webpack-13-64",
	      status: 1,
	      signal: null,
	      elapsedMs: 500,
	      failures: [],
	      stdout: "",
	      stderr: "",
	    },
	  ],
	});

	assert.equal(summary.status, "fail");
	assert.equal(summary.failureCount, 1);
	assert.equal(summary.failures[0].fixture, "group:webpack:13/64");
	assert.match(summary.failures[0].messages[0], /no failed fixture inventory was parsed/);
});

test("harvest summary records stopped deferred targets as slow fixtures", () => {
  const fixture = "test/e2e/app-dir/segment-cache/vary-params-base-dynamic/vary-params-base-dynamic.test.ts";
  const summary = createSummary({
    startedAt: "2026-06-20T00:00:00.000Z",
    finishedAt: "2026-06-20T00:10:00.000Z",
    slowMs: 1000,
    deferredExit: true,
    results: [
      {
        kind: "fixture",
        bundler: "webpack",
        group: "fixture",
        fixture,
        name: "slow-fixture",
        status: null,
        signal: "DEFERRED_HARVEST_EXIT",
        deferred: true,
        deferredAt: "2026-06-20T00:05:00.000Z",
        deferAfterMs: 300000,
        elapsedMs: 305000,
        failures: [],
        stdout: "",
        stderr: "",
      },
    ],
  });

  assert.equal(summary.status, "fail");
  assert.equal(summary.deferredExit, true);
  assert.equal(summary.failureCount, 1);
  assert.equal(summary.failures[0].bucket, "slow fixture");
  assert.equal(summary.failures[0].fixture, fixture);
  assert.match(summary.failures[0].messages[0], /target deferred after 300000ms/);
});

test("harvest failure ledger accumulates failures and closes later passes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-ledger-"));
  const nextDir = path.join(dir, "next");
  const fixture = "test/e2e/app-dir/segment-cache/prefetch-auto/prefetch-auto.test.ts";
  fs.mkdirSync(path.dirname(path.join(nextDir, fixture)), { recursive: true });
  fs.writeFileSync(path.join(nextDir, fixture), `
describe('<Link prefetch="auto">', () => {
  it('works the same as if prefetch were undefined or null', () => {})
})
`);
  const ledgerFile = path.join(dir, "ledger.jsonl");
  const failedSummary = createSummary({
    startedAt: "2026-06-20T00:00:00.000Z",
    finishedAt: "2026-06-20T00:01:00.000Z",
    slowMs: 1000,
    results: [
      {
        kind: "fixture",
        bundler: "webpack",
        group: "42/64",
        fixture,
        name: "prefetch-auto-red",
        status: 1,
        signal: null,
        elapsedMs: 1500,
        logs: {
          stdout: path.join(dir, "stdout.log"),
          stderr: path.join(dir, "stderr.log"),
        },
        failures: [
          {
            fixture,
            messages: ["Expected a response containing the given string: Dynamic content"],
          },
        ],
        stdout: "",
        stderr: "",
      },
    ],
  });

  const opened = updateFailureLedger({
    summary: failedSummary,
    ledgerFile,
    harvestDir: path.join(dir, "red-run"),
    nextDir,
    now: "2026-06-20T00:02:00.000Z",
  });

  const id = `webpack|${fixture}`;
  assert.equal(opened.state.entries[id].status, "open");
  assert.equal(opened.state.entries[id].bucket, "segment-cache/PPR prefetch");
  assert.deepEqual(opened.state.entries[id].testTitles, [
    '<Link prefetch="auto">',
    "works the same as if prefetch were undefined or null",
  ]);

  const passedSummary = createSummary({
    startedAt: "2026-06-20T00:03:00.000Z",
    finishedAt: "2026-06-20T00:04:00.000Z",
    slowMs: 1000,
    results: [
      {
        kind: "fixture",
        bundler: "webpack",
        group: "42/64",
        fixture,
        name: "prefetch-auto-green",
        status: 0,
        signal: null,
        elapsedMs: 900,
        logs: {
          stdout: path.join(dir, "stdout-green.log"),
          stderr: path.join(dir, "stderr-green.log"),
        },
        failures: [],
        stdout: "",
        stderr: "",
      },
    ],
  });

  const closed = updateFailureLedger({
    summary: passedSummary,
    ledgerFile,
    harvestDir: path.join(dir, "green-run"),
    nextDir,
    now: "2026-06-20T00:05:00.000Z",
  });

  assert.equal(closed.state.entries[id].status, "closed");
  assert.equal(closed.state.entries[id].closeReason, "fixture passed in later harvest");
  const events = fs.readFileSync(ledgerFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.event), ["opened", "closed"]);
});

test("harvest failure ledger does not close fixtures from partial test-name passes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brrrd-ledger-partial-"));
  const nextDir = path.join(dir, "next");
  const fixture = "test/e2e/app-dir/segment-cache/vary-params-base-dynamic/vary-params-base-dynamic.test.ts";
  fs.mkdirSync(path.dirname(path.join(nextDir, fixture)), { recursive: true });
  fs.writeFileSync(
    path.join(nextDir, fixture),
    "it('browser-triggered revalidation uses server-action-tag-layout-max', () => {})\n",
  );
  const ledgerFile = path.join(dir, "ledger.jsonl");
  const id = `webpack|${fixture}`;

  updateFailureLedger({
    summary: createSummary({
      startedAt: "2026-06-20T00:00:00.000Z",
      finishedAt: "2026-06-20T00:01:00.000Z",
      slowMs: 1000,
      results: [
        {
          kind: "fixture",
          bundler: "webpack",
          group: "fixture",
          fixture,
          name: "vary-full-red",
          status: 1,
          signal: null,
          elapsedMs: 1500,
          logs: {
            stdout: path.join(dir, "stdout.log"),
            stderr: path.join(dir, "stderr.log"),
          },
          failures: [
            {
              fixture,
              bucket: "slow fixture",
              messages: ["browserContext.newPage: Target page, context or browser has been closed"],
            },
          ],
          stdout: "",
          stderr: "",
        },
      ],
    }),
    ledgerFile,
    harvestDir: path.join(dir, "red-run"),
    nextDir,
    now: "2026-06-20T00:02:00.000Z",
  });

  const partialPass = updateFailureLedger({
    summary: createSummary({
      startedAt: "2026-06-20T00:03:00.000Z",
      finishedAt: "2026-06-20T00:04:00.000Z",
      slowMs: 1000,
      results: [
        {
          kind: "fixture",
          bundler: "webpack",
          group: "fixture",
          fixture,
          partialTestNamePattern: "browser-triggered revalidation uses server-action-tag-layout-max",
          name: "vary-single-green",
          status: 0,
          signal: null,
          elapsedMs: 900,
          logs: {
            stdout: path.join(dir, "stdout-green.log"),
            stderr: path.join(dir, "stderr-green.log"),
          },
          failures: [],
          stdout: "",
          stderr: "",
        },
      ],
    }),
    ledgerFile,
    harvestDir: path.join(dir, "green-partial-run"),
    nextDir,
    now: "2026-06-20T00:05:00.000Z",
  });

  assert.equal(partialPass.state.entries[id].status, "open");
  const events = fs.readFileSync(ledgerFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.event), ["opened", "partial-pass"]);
});
