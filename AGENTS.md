# AGENTS.md

This repository publishes the standalone `@brrrd/adapter` package for the
brrrd runtime.

## Local npm Publish

Automated releases publish from `.github/workflows/release.yml` on `v*` tags via
npm Trusted Publishing (OIDC), using npm 11.17.0 with no npm deployment token.
Already-published versions are skipped so release re-runs succeed.

Use the repository-local `.npmrc` only for manual fallback publishing. It is
intentionally ignored by git because it contains the npm deployment token.

Before a manual fallback publish, verify that `.npmrc` exists and contains a
valid token:

```ini
registry=https://registry.npmjs.org/
@brrrd:registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=...
access=public
```

Publish from this repository root with:

```sh
pnpm publish --access public
```

Do not commit `.npmrc`, `.env`, npm tokens, or other deployment secrets.
