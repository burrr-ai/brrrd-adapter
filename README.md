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
  -> RuntimeDependencyPolicy
  -> CompatibilityValidator
  -> BrrrdManifestEmitter
```

`ctx.routing` and `ctx.outputs` are the primary source of truth. Raw `.next`
manifests may be read only through a supplementary layer for validation or gaps
not exposed by the Adapter API. Because brrrd is currently internally opened,
manifest/runtime backward compatibility is not a goal; prefer the clean final
contract over bridge layers.

One important supplement is Next's `middleware-manifest.json`: proxy/middleware
records provide matcher/env/wasm metadata, and `functions` records describe
Edge app/page/API route chunks. The adapter compiles those function records into
`manifest.edgeFunctions`; it does not infer Edge runtime files from hard-coded
`.next` filenames.

Routing regexes come from the `sourceRegex` field on each `ctx.routing` phase
entry (`beforeFiles[]`, `afterFiles[]`, `dynamicRoutes[]`, etc.) whenever Next
provides one. Some Adapter API outputs currently omit a `dynamicRoutes[]` entry
for a dynamic request output, so the routing compiler has a narrow fallback that
uses Next's own `route-regex` compiler for that pathname. Do not add ad-hoc
regex generation at call sites, and do not assume a top-level
`ctx.routing.sourceRegex` field.

Pages Router automatic static optimization can emit dynamic static templates
such as `/[post]` or `/[post]/[cmnt]`. Those are not literal bracket URL paths:
the routing compiler registers them with Next's route-regex semantics while the
artifact planner still stores the template under a collision-safe static path.
For i18n SSG, default-locale files such as `/en/posts/a` and their
`/_next/data/<build>/en/...` JSON siblings also get public unprefixed aliases
(`/posts/a`, `/_next/data/<build>/...`) that point at the same stored artifact.

The emitted brrrd manifest is coupled to the runtime schema. A schema-breaking
adapter release must be tested with the matching brrrd runtime/fleet build before
publish/deploy is considered complete. The minimum manifest contract is
`schemaVersion`, `build`, `routes[]`, phase-aware `routing`,
`artifacts[].packagePath`, optional `middleware`, optional `edgeFunctions`, and
`compatibility`.

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
- **Image config**: the adapter preserves Next's image rendering config instead
  of forcing `images.unoptimized`. Apps may still opt into `unoptimized`
  deliberately, but the compiler should not silently downgrade `<Image>` HTML.
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

Next server runtime dependency handling lives in `src/runtime-dependency-policy.ts`.
It owns brrrd-provided Node builtins, always-external platform stubs, and
optional Next/runtime packages that should be externalized only when absent from
the app. Missing optional packages receive Node-shaped runtime behavior instead
of failing esbuild at adapter compile time.

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
fleet/AWS. The manual workflow defaults to a small `1/64` deploy-test shard with
`IS_WEBPACK_TEST=1` until early failures are classified. The workflow also has an
explicit bundler input: `webpack`, `turbopack`, or `next-default`. This matters
because current Next canary defaults an unqualified `next build` to Turbopack.
Set `ADAPTER_DIR` to this checkout and `BRRRD_BIN` to a built brrrd runtime
binary when running the scripts manually. Current official-suite coverage is
tracked in `docs/next-official-harness-matrix.md`.

The GitHub workflow checks out the private `burrr-ai/brrrd` runtime repo through
the `RUNTIME_REPO_DEPLOY_KEY` secret. Use a read-only deploy key on the runtime
repo rather than a broad personal token.
