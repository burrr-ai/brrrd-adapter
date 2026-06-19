# Next official adapter harness matrix

This file records the current pass/defer/exclude state for the Next official deploy adapter suite.

## Status

Initial local harness integration exists. The CI workflow runs one small deploy-test shard manually or on schedule
before this becomes a pull-request gate. The current smoke shard is intentionally small (`1/64`) until failures are
classified and runtime coverage is stable. The default smoke is the regular Next deploy-test mode; Turbopack is a
separate opt-in axis.

## Failure categories

- `pass`: passes on the local brrrd deploy harness.
- `adapter-bug`: `@brrrd/adapter` build-output compiler, packaging, or manifest issue.
- `runtime-bug`: brrrd runtime routing, cache, Node compatibility, or static serving issue.
- `fleet-required`: local brrrd is not enough; the test needs live deploy/log/cleanup semantics.
- `next-assumption`: the test assumes Vercel/fleet-like infrastructure directly. Link an upstream issue when possible.
- `unsupported-yet`: valid Next feature that brrrd intentionally has not implemented yet.
- `flaky-infra`: timeout, port leak, browser install, or harness infrastructure issue.

## Current matrix

| Scope | Status | Notes |
| --- | --- | --- |
| Local deploy script smoke | pass | 2026-06-19: copied `brrrd/examples/nextjs-basic` to a temp app, ran `deploy -> curl / -> logs -> cleanup -> cleanup`; `/` returned 200 and required log markers were present. |
| Private runtime checkout | pass | 2026-06-19: configured `RUNTIME_REPO_DEPLOY_KEY` as a read-only deploy key for `burrr-ai/brrrd`; workflow now checks out runtime submodules recursively. |
| Official deploy suite `1/16` | flaky-infra | 2026-06-19 run `27823794521` reached `Run official deploy adapter tests` after adapter/runtime/Next builds, then stayed in that step for more than 15 minutes without available logs. It was cancelled and the workflow was updated to use a smaller `1/64` smoke shard plus timeout and diagnostics collection. |
| Official deploy suite `1/64` with Turbopack forced | unsupported-yet | 2026-06-19 run `27824888633` selected 17 tests, failed 11, and uploaded diagnostics. This was not a valid baseline because the workflow forced `IS_TURBOPACK_TEST=1`; observed failures include adapter compiler assumptions about `server/edge-runtime-webpack.js`, runtime 404/500 behavior, and Next/Turbopack fixture build errors such as `TypeError: y.get is not a function`. Turbopack coverage is now opt-in. |
| Official deploy suite `1/64` default mode | pending | Rerun after removing forced Turbopack mode. |
| Full official deploy suite | pending | Promote shard coverage after first failures are classified. |

## Policy

Exclusions are temporary. Every deferred or excluded test must include a reason, owner, and condition for retry.
