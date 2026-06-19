import assert from "node:assert/strict";
import { test } from "node:test";

import { modifyConfig } from "../dist/config.js";

test("modifyConfig does not downgrade Next image rendering semantics", () => {
  const config = {
    images: {
      domains: ["i.imgur.com"],
      deviceSizes: [1234],
    },
  };

  const out = modifyConfig(config, {
    phase: "phase-production-build",
    nextVersion: "16.3.0-canary.58",
  });

  assert.equal(out.images.unoptimized, undefined);
  assert.deepEqual(out.images.deviceSizes, [1234]);
});
