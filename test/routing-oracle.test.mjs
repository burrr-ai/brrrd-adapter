import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import routing from '@next/routing';

const { resolveRoutes } = routing;

const fixtureUrl = new URL('./fixtures/next_routing_oracle.json', import.meta.url);

function sortedObject(entries) {
  return Object.fromEntries(
    Object.entries(entries ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function headersObject(headers) {
  return Object.fromEntries([...headers.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function queryObject(query) {
  if (!query) return undefined;
  return sortedObject(query);
}

function normalizeResult(result) {
  const out = {};
  if (result.redirect) {
    out.redirect = {
      url: result.redirect.url.pathname + result.redirect.url.search,
      status: result.redirect.status,
    };
  }
  if (result.externalRewrite) {
    out.externalRewrite = result.externalRewrite.pathname + result.externalRewrite.search;
  }
  if (result.middlewareResponded) out.middlewareResponded = true;
  if (result.resolvedPathname) out.resolvedPathname = result.resolvedPathname;
  if (result.resolvedQuery) out.resolvedQuery = queryObject(result.resolvedQuery);
  if (result.invocationTarget) {
    out.invocationTarget = {
      pathname: result.invocationTarget.pathname,
      query: queryObject(result.invocationTarget.query) ?? {},
    };
  }
  if (result.resolvedHeaders) out.resolvedHeaders = headersObject(result.resolvedHeaders);
  if (result.status !== undefined) out.status = result.status;
  if (result.routeMatches) out.routeMatches = sortedObject(result.routeMatches);
  return out;
}

test('@next/routing oracle fixture stays current', async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  for (const testCase of fixture.cases) {
    const result = await resolveRoutes({
      url: new URL(testCase.url),
      buildId: fixture.buildId,
      basePath: fixture.basePath,
      requestBody: new ReadableStream(),
      headers: new Headers(testCase.headers),
      pathnames: fixture.pathnames,
      routes: {
        beforeMiddleware: [...fixture.routes.headers, ...fixture.routes.redirects],
        beforeFiles: fixture.routes.beforeFiles,
        afterFiles: fixture.routes.afterFiles,
        dynamicRoutes: fixture.routes.dynamicRoutes,
        onMatch: [],
        fallback: fixture.routes.fallback,
        shouldNormalizeNextData: false,
      },
      invokeMiddleware: async () => ({}),
    });
    assert.deepEqual(normalizeResult(result), testCase.expected, testCase.name);
  }
});
