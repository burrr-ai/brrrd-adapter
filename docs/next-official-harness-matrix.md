# Next official adapter harness matrix

This file records the current pass/defer/exclude state for the Next official deploy adapter suite.

## Status

Initial local harness integration exists. The first CI workflow runs one small deploy-test shard manually or on schedule
before this becomes a pull-request gate.

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
| Official deploy suite `1/16` | blocked | First run reached `Checkout brrrd runtime` and failed because `burrr-ai/brrrd` is private. Configure `RUNTIME_REPO_DEPLOY_KEY` with a read-only deploy key, then rerun. |
| Full official deploy suite | pending | Promote shard coverage after first failures are classified. |

## Policy

Exclusions are temporary. Every deferred or excluded test must include a reason, owner, and condition for retry.
