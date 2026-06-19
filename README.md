# @brrrd/adapter

Next.js build adapter that packages a Next app for the **brrrd** runtime (the
comwit.io deployment plane). On `next build` it emits a `dist/brrrd/` package
(manifest + bundled handlers + static + runtime) that `brrrd-fleet deploy` ships.

Requires **Next.js ≥ 16.2**.

## Architecture direction

This adapter is the source of truth for `@brrrd/adapter`; the historical
`packages/adapter` inside the brrrd runtime repo is not used.

The adapter should behave as a **Next build-output compiler**, not as a pile of
case-specific `.next` copy rules. Its build pipeline is expected to normalize
Next's `onBuildComplete(ctx)` contract into:

```txt
NextBuildModel
  -> RoutingCompiler
  -> ArtifactPlanner
  -> CompatibilityValidator
  -> BrrrdManifestEmitter
```

`ctx.routing` and `ctx.outputs` are the primary source of truth. Raw `.next`
manifests may be read only through a supplementary layer for validation or gaps
not exposed by the Adapter API. Because brrrd is currently internally opened,
manifest/runtime backward compatibility is not a goal; prefer the clean final
contract over bridge layers.

Routing regexes come from the `sourceRegex` field on each `ctx.routing` phase
entry (`beforeFiles[]`, `afterFiles[]`, `dynamicRoutes[]`, etc.). Do not derive a
source-of-truth regex from a pathname, and do not assume a top-level
`ctx.routing.sourceRegex` field.

The emitted brrrd manifest is coupled to the runtime schema. A schema-breaking
adapter release must be tested with the matching brrrd runtime/fleet build before
publish/deploy is considered complete. The minimum manifest contract is
`schemaVersion`, `build`, `routes[]`, phase-aware `routing`,
`artifacts[].packagePath`, and `compatibility`.

## Use

```sh
pnpm add @brrrd/adapter
```

`next.config.ts`:

```ts
import type { NextConfig } from "next";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const nextConfig: NextConfig = {
  adapterPath: require.resolve("@brrrd/adapter"),
  // brrrd isolates have no native addons → keep image optimization off.
  images: { unoptimized: true },
};
export default nextConfig;
```

Then `next build` produces `dist/brrrd/`. Deploy it with `brrrd-fleet deploy
--package dist/brrrd ...`.

### Conventions for apps on the platform

- **Database**: use libSQL (Louhi), not a Cloudflare/Workers binding —
  `@tursodatabase/serverless/compat` + `drizzle-orm/libsql/web`, reading your
  `DATABASE_URL` / `DATABASE_AUTH_TOKEN` from the brrrd env bundle.
- **No native `.node` addons** in the served request path. `next/og` image
  routes are handled through Next's WASM fallback path, so they do not need
  `export const runtime = "edge"` just to avoid optional `sharp` traces.
- **Middleware matcher**: standard Next matcher regexes, including common
  negative-lookahead patterns such as `/((?!api|...).*)`, are supported by the
  brrrd runtime.

### Next compatibility policies

The adapter keeps platform-specific Next built-in fixes in `src/compatibility/`
instead of scattering one-off branches through the build pipeline. Current
policies:

- `next/og`: routes using `ImageResponse` use Next's WASM renderer fallback.
  Optional traced `sharp` native files are excluded, and the edge/WASM renderer
  plus its fallback font are bundled into the request handler for isolates.

> Version note: the adapter's manifest format is coupled to the brrrd runtime
> version. Use an adapter release that matches your deployed runtime.

## Next official adapter harness

This repo includes the deploy/logs/cleanup script contract expected by Next's
official adapter harness:

- `scripts/e2e-deploy.sh`
- `scripts/e2e-logs.sh`
- `scripts/e2e-cleanup.sh`
- `.github/workflows/next-adapter-harness.yml`

The first workflow target is a local `brrrd <dist/brrrd>` deploy harness, not
fleet/AWS. The manual workflow defaults to a small `1/64` deploy-test shard in
Next's regular deploy-test mode until early failures are classified. Turbopack
coverage is available as an opt-in workflow input and is tracked separately.
Set `ADAPTER_DIR` to this checkout and `BRRRD_BIN` to a built brrrd runtime
binary when running the scripts manually. Current official-suite coverage is
tracked in `docs/next-official-harness-matrix.md`.

The GitHub workflow checks out the private `burrr-ai/brrrd` runtime repo through
the `RUNTIME_REPO_DEPLOY_KEY` secret. Use a read-only deploy key on the runtime
repo rather than a broad personal token.
