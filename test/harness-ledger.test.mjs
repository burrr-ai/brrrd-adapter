import assert from "node:assert/strict";
import { test } from "node:test";

import { validateCompletedLocalHarnessResult } from "../scripts/harness-ledger.mjs";

test("ledger import rejects incomplete local harness metadata", () => {
  assert.throws(
    () => validateCompletedLocalHarnessResult({
      startedAt: "2026-06-23T10:43:07.420Z",
      mode: "fixture",
      bundler: "webpack",
    }, "/tmp/local-harness.json"),
    /local-harness-result\.json/,
  );
});

test("ledger import accepts completed local harness results", () => {
  assert.doesNotThrow(() => validateCompletedLocalHarnessResult({
    startedAt: "2026-06-23T10:43:07.420Z",
    finishedAt: "2026-06-23T10:44:35.929Z",
    status: 0,
    signal: null,
    mode: "fixture",
    bundler: "webpack",
  }, "/tmp/local-harness-result.json"));
});
