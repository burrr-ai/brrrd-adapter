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

test("App prerender response metadata is emitted on filesystem routes", () => {
  const routes = compileRouteTable(
    context({
      appPages: [appPage("/redirect-page")],
      prerenders: [
        {
          id: "/redirect-page",
          pathname: "/redirect-page",
          parentOutputId: "/redirect-page",
        },
      ],
    }),
    {
      staticRoutes: [],
      appPrerenderDataRoutes: [],
      pprSegmentPrefetchRoutes: [],
      prerenderResponseMeta: [{
        pathname: "/redirect-page",
        status: 307,
        headers: [{ key: "location", value: "/" }],
      }],
    },
  );

  assert.deepEqual(
    routes.find((route) => route.id === "prerender-redirect-page"),
    {
      id: "prerender-redirect-page",
      pattern: "^/redirect-page$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/redirect-page",
      status: 307,
      headers: [{ key: "location", value: "/" }],
    },
  );
});

test("prerendered decoded public paths also match encoded request paths", () => {
  const routes = compileRouteTable(
    context({
      appPages: [appPage("/[id]"), appPage("/[id].rsc")],
      prerenders: [
        {
          id: "/sticks & stones",
          pathname: "/sticks & stones",
          parentOutputId: "/[id]",
        },
      ],
    }),
    {
      staticRoutes: [],
      appPrerenderDataRoutes: [
        { pathname: "/sticks & stones.rsc", sourceRel: "sticks & stones.rsc" },
      ],
      pprSegmentPrefetchRoutes: [],
      prerenderResponseMeta: [],
    },
  );

  assert.deepEqual(
    routes.find((route) => route.id === "prerender-sticks & stones-encoded-alias"),
    {
      id: "prerender-sticks & stones-encoded-alias",
      pattern: "^/sticks%20%26%20stones$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/sticks & stones",
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "app-prerender-data-sticks & stones_rsc-encoded-alias"),
    {
      id: "app-prerender-data-sticks & stones_rsc-encoded-alias",
      pattern: "^/sticks%20%26%20stones\\.rsc$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/sticks & stones.rsc",
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

test("exact handler routes use Next static route regex before dynamic routes", () => {
  const routes = compileRouteTable(
    context({
      pages: [
        appPage("/router"),
      ],
      pagesApi: [
        appPage("/api/user/login"),
        appPage("/api/user/[id]"),
      ],
      dynamicRoutes: [
        {
          source: "/api/user/[id]",
          sourceRegex: "^/api/user/(?<nxtPid>[^/]+?)(?:/)?$",
          destination: "/api/user/[id]",
        },
      ],
    }),
    {
      staticRoutes: [
        {
          page: "/router",
          regex: "^/router(?:/)?$",
        },
        {
          page: "/api/user/login",
          regex: "^/api/user/login(?:/)?$",
        },
      ],
    },
  );

  assert.equal(
    routes.find((route) => route.id === "router").pattern,
    "^/router(?:/)?$",
  );
  assert.equal(
    routes.find((route) => route.id === "api-user-login").pattern,
    "^/api/user/login(?:/)?$",
  );

  const firstLoginMatch = routes.find((route) => new RegExp(route.pattern).test("/api/user/login/"));
  assert.equal(firstLoginMatch.id, "api-user-login");
});

test("PPR segment prefetch routes are filesystem static routes before dynamic RSC handlers", () => {
  const routes = compileRouteTable(
    context({
      appPages: [
        appPage("/[slug]"),
        appPage("/[slug].rsc"),
      ],
      dynamicRoutes: [
        {
          source: "/[slug]",
          sourceRegex: "^/(?<nxtPslug>[^/]+?)(?:/)?$",
          destination: "/[slug]",
        },
        {
          source: "/[slug].rsc",
          sourceRegex: "^/(?<nxtPslug>[^/]+?)(?<rscSuffix>\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$",
          destination: "/[slug].rsc",
        },
      ],
    }),
    {
      appPrerenderDataRoutes: [],
      staticRoutes: [],
      pprSegmentPrefetchRoutes: [{
        page: "/[slug]",
        source: "^/(?<nxtPslug>[^/]+?)\\.segments/\\$d\\$slug(?<segment>/__PAGE__\\.segment\\.rsc|\\.segment\\.rsc)(?:/)?$",
        destination: "/[slug].segments/$d$slug$segment",
      }],
    },
  );

  const segmentRoute = routes.find((route) => route.id === "ppr-segment-_slug_-0");
  assert.deepEqual(segmentRoute, {
    id: "ppr-segment-_slug_-0",
    pattern: "^/((?<nxtPslug>[^/]+?)\\.segments/\\$d\\$slug(?<segment>/__PAGE__\\.segment\\.rsc|\\.segment\\.rsc))(?:/)?$",
    type: "static",
    runtime: "nodejs",
    bundle: "",
    file: "/",
    params: ["path"],
  });

  const dynamicRscIndex = routes.findIndex((route) => route.id === "_slug__rsc");
  const segmentIndex = routes.findIndex((route) => route.id === "ppr-segment-_slug_-0");
  assert.ok(segmentIndex >= 0);
  assert.ok(dynamicRscIndex >= 0);
  assert.ok(segmentIndex < dynamicRscIndex);
  const firstSegmentMatch = routes.find((route) => (
    new RegExp(route.pattern).test("/alpha.segments/$d$slug/__PAGE__.segment.rsc")
  ));
  assert.equal(firstSegmentMatch.id, "ppr-segment-_slug_-0");
});

test("App prerender RSC data artifacts are exact static routes before dynamic RSC handlers", () => {
  const routes = compileRouteTable(
    context({
      appPages: [
        appPage("/[slug].rsc"),
      ],
      dynamicRoutes: [
        {
          source: "/[slug].rsc",
          sourceRegex: "^/(?<nxtPslug>[^/]+?)(?<rscSuffix>\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$",
          destination: "/[slug].rsc",
        },
      ],
    }),
    {
      staticRoutes: [],
      appPrerenderDataRoutes: [
        { pathname: "/alpha.rsc", sourceRel: "alpha.rsc" },
        {
          pathname: "/alpha.segments/_tree.segment.rsc",
          sourceRel: "alpha.segments/_tree.segment.rsc",
        },
      ],
      pprSegmentPrefetchRoutes: [],
    },
  );

  assert.deepEqual(
    routes.find((route) => route.id === "app-prerender-data-alpha_rsc"),
    {
      id: "app-prerender-data-alpha_rsc",
      pattern: "^/alpha\\.rsc$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/alpha.rsc",
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "app-prerender-data-alpha_segments-_tree_segment_rsc"),
    {
      id: "app-prerender-data-alpha_segments-_tree_segment_rsc",
      pattern: "^/alpha\\.segments/_tree\\.segment\\.rsc$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/alpha.segments/_tree.segment.rsc",
    },
  );

  const dynamicRscIndex = routes.findIndex((route) => route.id === "_slug__rsc");
  const routeRscIndex = routes.findIndex((route) => route.id === "app-prerender-data-alpha_rsc");
  const treeIndex = routes.findIndex((route) => (
    route.id === "app-prerender-data-alpha_segments-_tree_segment_rsc"
  ));
  assert.ok(routeRscIndex < dynamicRscIndex);
  assert.ok(treeIndex < dynamicRscIndex);
});
