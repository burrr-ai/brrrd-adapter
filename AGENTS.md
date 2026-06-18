# AGENTS.md

This repository publishes the standalone `@brrrd/adapter` package for the
brrrd runtime.

## Local npm Publish

Use the repository-local `.npmrc` for npm publishing. It is intentionally ignored
by git because it contains the npm deployment token.

Before publishing, verify that `.npmrc` exists and contains a valid token:

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
