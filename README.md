# @brrrd/adapter

Next.js build adapter that packages a Next app for the **brrrd** runtime (the
comwit.io deployment plane). On `next build` it emits a `dist/brrrd/` package
(manifest + bundled handlers + static + runtime) that `brrrd-fleet deploy` ships.

Requires **Next.js ≥ 16.2**.

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

> Version note: the adapter's manifest format is coupled to the brrrd runtime
> version. Use an adapter release that matches your deployed runtime.
