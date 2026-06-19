import assert from "node:assert/strict";
import test from "node:test";

import { createNextBuildModel } from "../dist/model.js";
import { compileRouteTable } from "../dist/routing-compiler.js";

function context({
  appPages = [],
  appRoutes = [],
  pages = [],
  pagesApi = [],
  prerenders = [],
  staticFiles = [],
  dynamicRoutes = [],
  config = {},
}) {
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
      prerenders,
      appPages,
      appRoutes,
      pages,
      pagesApi,
      staticFiles,
    },
    projectDir: "/tmp/brrrd-routing-test",
    repoRoot: "/tmp/brrrd-routing-test",
    distDir: "/tmp/brrrd-routing-test/.next",
    config,
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

function staticFile(pathname, filePath) {
  return {
    id: pathname,
    pathname,
    filePath,
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

test("static Pages Router index HTML is exposed at the public root path", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(context({
    staticFiles: [
      staticFile("/index", `${distDir}/server/pages/index.html`),
      staticFile("/nested/index", `${distDir}/server/pages/nested/index.html`),
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "static-index"),
    {
      id: "static-index",
      pattern: "^/$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/index",
      immutable: false,
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "static-nested"),
    {
      id: "static-nested",
      pattern: "^/nested$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/nested/index",
      immutable: false,
    },
  );
});

test("static prerender routes are exposed before matching page handlers", () => {
  const routes = compileRouteTable(context({
    appPages: [appPage("/server-action-inline")],
    prerenders: [
      {
        id: "/server-action-inline",
        pathname: "/server-action-inline",
        parentOutputId: "/server-action-inline",
      },
    ],
  }));

  const ids = routes.map((route) => route.id);
  assert.ok(ids.indexOf("prerender-server-action-inline") < ids.indexOf("server-action-inline"));
  assert.deepEqual(
    routes.find((route) => route.id === "prerender-server-action-inline"),
    {
      id: "prerender-server-action-inline",
      pattern: "^/server-action-inline$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/server-action-inline",
    },
  );
});

test("dynamic route table derives a Next-compatible regex when Adapter API sourceRegex is missing", () => {
  const routes = compileRouteTable(context({
    appPages: [
      appPage("/posts/[id]"),
      appPage("/en/posts/[...slug]"),
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "posts-_id_"),
    {
      id: "posts-_id_",
      pattern: "^\\/posts\\/([^/]+?)(?:\\/)?$",
      type: "page",
      runtime: "nodejs",
      params: ["id"],
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "en-posts-____slug_"),
    {
      id: "en-posts-____slug_",
      pattern: "^\\/en\\/posts\\/(.+?)(?:\\/)?$",
      type: "page",
      runtime: "nodejs",
      params: ["slug"],
    },
  );
});

test("public static file storage avoids parent file and child directory collisions", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(context({
    staticFiles: [
      staticFile("/[post]", `${distDir}/server/pages/[post].html`),
      staticFile("/[post]/comments", `${distDir}/server/pages/[post]/comments.html`),
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "static-_post_"),
    {
      id: "static-_post_",
      pattern: "^\\/([^/]+?)(?:\\/)?$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/[post]/index",
      immutable: false,
      params: ["post"],
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "static-_post_-comments"),
    {
      id: "static-_post_-comments",
      pattern: "^\\/([^/]+?)\\/comments(?:\\/)?$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/[post]/comments",
      immutable: false,
      params: ["post"],
    },
  );
});

test("auto-export dynamic static templates match concrete request paths after exact routes", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(context({
    staticFiles: [
      staticFile("/[post]", `${distDir}/server/pages/[post]/index.html`),
      staticFile("/[post]/[cmnt]", `${distDir}/server/pages/[post]/[cmnt].html`),
      staticFile("/commonjs1", `${distDir}/server/pages/commonjs1.html`),
    ],
  }));

  const firstCommon = routes.find((route) => new RegExp(route.pattern).test("/commonjs1"));
  const firstPost = routes.find((route) => new RegExp(route.pattern).test("/post-1"));
  const firstComment = routes.find((route) => new RegExp(route.pattern).test("/zeit/cmnt-2"));

  assert.equal(firstCommon.id, "static-commonjs1");
  assert.equal(firstPost.id, "static-_post_");
  assert.equal(firstComment.id, "static-_post_-_cmnt_");
  assert.ok(
    routes.findIndex((route) => route.id === "static-commonjs1")
      < routes.findIndex((route) => route.id === "static-_post_"),
  );
  assert.ok(
    routes.findIndex((route) => route.id === "static-_post_-_cmnt_")
      < routes.findIndex((route) => route.id === "static-_post_"),
  );
});

test("i18n default-locale prerenders are exposed at public unprefixed paths", () => {
  const routes = compileRouteTable(context({
    config: { i18n: { locales: ["en", "fr"], defaultLocale: "en" } },
    prerenders: [
      { id: "/en/posts/a", pathname: "/en/posts/a" },
      {
        id: "/_next/data/test-build/en/posts/a.json",
        pathname: "/_next/data/test-build/en/posts/a.json",
      },
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "prerender-en-posts-a-default-locale-alias"),
    {
      id: "prerender-en-posts-a-default-locale-alias",
      pattern: "^/posts/a$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/en/posts/a",
    },
  );
  assert.deepEqual(
    routes.find((route) => (
      route.id === "prerender-_next-data-test-build-en-posts-a_json-default-locale-alias"
    )),
    {
      id: "prerender-_next-data-test-build-en-posts-a_json-default-locale-alias",
      pattern: "^/_next/data/test-build/posts/a\\.json$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/_next/data/test-build/en/posts/a.json",
    },
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
