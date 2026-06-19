import assert from "node:assert/strict";
import test from "node:test";

import { createNextBuildModel } from "../dist/model.js";
import { compileRouteTable } from "../dist/routing-compiler.js";

function context({ appPages = [], appRoutes = [], pages = [], pagesApi = [], dynamicRoutes = [] }) {
  return createNextBuildModel({
    routing: {
      beforeMiddleware: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes,
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: null,
    },
    outputs: {
      staticFiles: [],
      prerenders: [],
      appPages,
      appRoutes,
      pages,
      pagesApi,
    },
    projectDir: "/tmp/brrrd-routing-test",
    repoRoot: "/tmp/brrrd-routing-test",
    distDir: "/tmp/brrrd-routing-test/.next",
    config: {},
    nextVersion: "16.2.0",
    buildId: "test-build",
  });
}

function appPage(pathname) {
  return {
    id: pathname,
    pathname,
    runtime: "nodejs",
  };
}

test("dynamic route table uses ctx.routing sourceRegex instead of deriving from pathname", () => {
  const routes = compileRouteTable(context({
    appPages: [appPage("/posts/[id]")],
    dynamicRoutes: [
      {
        source: "/posts/[id]",
        sourceRegex: "^/posts/(?<id>[^/]+?)(?:/)?$",
        destination: "/posts/[id]",
      },
    ],
  }));

  const route = routes.find((item) => item.id === "posts-_id_");
  assert.deepEqual(route, {
    id: "posts-_id_",
    pattern: "^/posts/(?<id>[^/]+?)(?:/)?$",
    type: "page",
    runtime: "nodejs",
    params: ["id"],
  });
});

test("dynamic route table fails fast when Adapter API sourceRegex is missing", () => {
  assert.throws(
    () => compileRouteTable(context({ appPages: [appPage("/posts/[id]")] })),
    /missing ctx\.routing\.dynamicRoutes sourceRegex/,
  );
});

test("internal intercepting route outputs are bundled but not exposed without a public sourceRegex", () => {
  const routes = compileRouteTable(context({
    appPages: [
      appPage("/posts/[id]"),
      appPage("/(.)posts/[id]"),
    ],
    dynamicRoutes: [
      {
        source: "/posts/[id]",
        sourceRegex: "^/posts/([^/]+)$",
        destination: "/posts/[id]",
      },
    ],
  }));

  const ids = routes.map((route) => route.id);
  assert.ok(ids.includes("posts-_id_"));
  assert.ok(!ids.includes("(_)posts-_id_"));
});

test("dynamic routes are ordered by Next-style specificity after sourceRegex lookup", () => {
  const routes = compileRouteTable(context({
    appPages: [
      appPage("/[...catchAll]"),
      appPage("/[...catchAll].rsc"),
      appPage("/posts/[id]"),
      appPage("/posts/[id].rsc"),
    ],
    dynamicRoutes: [
      {
        source: "/[...catchAll]",
        sourceRegex: "^/(.+)$",
        destination: "/[...catchAll]",
      },
      {
        source: "/[...catchAll].rsc",
        sourceRegex: "^/(.+)\\.rsc$",
        destination: "/[...catchAll].rsc",
      },
      {
        source: "/posts/[id]",
        sourceRegex: "^/posts/([^/]+)$",
        destination: "/posts/[id]",
      },
      {
        source: "/posts/[id].rsc",
        sourceRegex: "^/posts/([^/]+)\\.rsc$",
        destination: "/posts/[id].rsc",
      },
    ],
  }));

  const ids = routes.map((route) => route.id);
  assert.ok(ids.indexOf("posts-_id__rsc") < ids.indexOf("posts-_id_"));
  assert.ok(ids.indexOf("posts-_id_") < ids.indexOf("____catchAll__rsc"));
  assert.ok(ids.indexOf("____catchAll__rsc") < ids.indexOf("____catchAll_"));

  const firstMatch = routes.find((route) => new RegExp(route.pattern).test("/posts/1"));
  const firstRscMatch = routes.find((route) => new RegExp(route.pattern).test("/posts/1.rsc"));
  assert.equal(firstMatch.id, "posts-_id_");
  assert.equal(firstRscMatch.id, "posts-_id__rsc");
});
