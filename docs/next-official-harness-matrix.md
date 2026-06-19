# Next official adapter harness matrix

This file records the current pass/defer/exclude state for the Next official deploy adapter suite.

## Status

Initial local harness integration exists. The CI workflow runs one small deploy-test shard manually or on schedule
before this becomes a pull-request gate. The current smoke shard is intentionally small (`1/64`) until failures are
classified and runtime coverage is stable. The workflow makes the bundler axis explicit: `webpack` is the default
baseline, `turbopack` is tracked separately, and `next-default` records whatever the checked-out Next canary uses when
no bundler flag is supplied.

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
| Official deploy suite `1/64` with Turbopack forced | unsupported-yet | 2026-06-19 run `27824888633` selected 17 tests, failed 11, and uploaded diagnostics. This was not a valid baseline because the workflow forced `IS_TURBOPACK_TEST=1`; observed failures include adapter compiler assumptions about `server/edge-runtime-webpack.js`, runtime 404/500 behavior, and Next/Turbopack fixture build errors such as `TypeError: y.get is not a function`. Turbopack coverage remains a separate axis. |
| Official deploy suite `1/64` with Next default bundler | unsupported-yet | 2026-06-19 run `27825901278` selected 17 tests and failed 11. This run did not set `IS_TURBOPACK_TEST`, but Next canary defaults an unqualified `next build` to Turbopack (`TURBOPACK=auto`), so it still was not the intended webpack baseline. The workflow now defaults to `IS_WEBPACK_TEST=1`; this run remains useful as `next-default` data. |
| Official deploy suite `1/64` webpack baseline | adapter-bug | 2026-06-19 run `27826986876` selected 17 tests with `IS_WEBPACK_TEST=1`: 7 passed and 10 failed. Repeated first blocker is adapter bundling of Pages Router runtime (`next/dist/compiled/next-server/pages.runtime.prod.js`) failing to resolve optional `critters`; affected suites include `404-page-app`, `scss/nested-global`, middleware matcher/basepath, image-from-node-modules, router-is-ready, and with-router. Separate follow-ups: `cache-components` and `ppr-root-param-rsc-fallback` fail during Next canary prerender/build with `TypeError: y.get is not a function`; `metadata-navigation` and `front-redirect-issue` reach runtime assertions/timeouts and need re-run after the adapter bundling blocker is removed. |
| Full official deploy suite | pending | Promote shard coverage after first failures are classified. |

## Policy

Exclusions are temporary. Every deferred or excluded test must include a reason, owner, and condition for retry.
