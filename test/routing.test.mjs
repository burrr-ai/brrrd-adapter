import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createNextBuildModel } from "../dist/model.js";
import { compileRouteTable, compileRouting } from "../dist/routing-compiler.js";

function context({
  appPages = [],
  appRoutes = [],
  pages = [],
  pagesApi = [],
  prerenders = [],
  staticFiles = [],
  dynamicRoutes = [],
  config = {},
  projectDir = "/tmp/brrrd-routing-test",
}) {
  const distDir = path.join(projectDir, ".next");
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
    projectDir,
    repoRoot: projectDir,
    distDir,
    config,
    nextVersion: "16.2.0",
    buildId: "test-build",
  });
}

function tempRoutingRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `brrrd-routing-${name}-`));
}

function writeFile(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function appPage(pathname, filePath) {
  return {
    id: pathname,
    pathname,
    runtime: "nodejs",
    ...(filePath ? { filePath } : {}),
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
    paramTypes: { id: "single" },
  });
});

test("Pages Router dynamic data outputs keep the public page handler pattern", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(context({
    pages: [
      {
        id: "blog-[slug]",
        pathname: "/blog/[slug]",
        runtime: "nodejs",
        filePath: `${distDir}/server/pages/blog/[slug].js`,
      },
      {
        id: "/_next/data/test-build/blog/[slug].json",
        pathname: "/_next/data/test-build/blog/[slug].json",
        runtime: "nodejs",
        filePath: `${distDir}/server/pages/blog/[slug].js`,
      },
    ],
    dynamicRoutes: [
      {
        source: "/blog/[slug]",
        sourceRegex: "^/_next/data/test\\-build[/]?/blog/(?<nxtPslug>[^/]+?)\\.json(?:/)?$",
        destination: "/_next/data/test-build/blog/[slug].json?nxtPslug=$nxtPslug",
      },
      {
        source: "/blog/[slug]",
        sourceRegex: "^/blog/(?<nxtPslug>[^/]+?)(?:/)?$",
        destination: "/blog/[slug]?nxtPslug=$nxtPslug",
      },
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "blog-_slug_"),
    {
      id: "blog-_slug_",
      pattern: "^/blog/(?<nxtPslug>[^/]+?)(?:/)?$",
      type: "page",
      runtime: "nodejs",
      params: ["slug"],
      paramTypes: { slug: "single" },
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "_next-data-test-build-blog-_slug__json"),
    {
      id: "_next-data-test-build-blog-_slug__json",
      pattern: "^/_next/data/test\\-build[/]?/blog/(?<nxtPslug>[^/]+?)\\.json(?:/)?$",
      type: "page",
      runtime: "nodejs",
      params: ["slug"],
      paramTypes: { slug: "single" },
    },
  );
});

test("Pages Router RSC fallback static outputs are not published as RSC data routes", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(context({
    staticFiles: [
      staticFile("/pages-dir", `${distDir}/server/pages/pages-dir.html`),
      staticFile("/pages-dir.rsc", `${distDir}/server/rsc-fallback.json`),
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "static-pages-dir"),
    {
      id: "static-pages-dir",
      pattern: "^/pages-dir$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/pages-dir",
      immutable: false,
    },
  );
  assert.equal(
    routes.some((route) => route.id === "static-pages-dir_rsc"),
    false,
  );
});

test("prerender routes preserve Adapter API ISR metadata", () => {
  const previousNow = Date.now;
  Date.now = () => 123_456;
  try {
    const distDir = "/tmp/brrrd-routing-test/.next";
    const routes = compileRouteTable(context({
      prerenders: [{
        id: "/stale",
        pathname: "/stale",
        filePath: `${distDir}/server/pages/stale.html`,
        fallback: {
          initialRevalidate: 5,
          initialExpiration: 31_536_000,
        },
        config: {
          bypassToken: "preview-token",
          allowHeader: ["x-prerender-revalidate"],
        },
      }],
    }));

    const route = routes.find((item) => item.id === "prerender-stale");
    assert.deepEqual(route.isr, {
      initialRevalidate: 5,
      initialExpire: 31_536_000,
      generatedAtMs: 123_456,
      bypassToken: "preview-token",
      allowHeader: ["x-prerender-revalidate"],
    });
  } finally {
    Date.now = previousNow;
  }
});

test("fallback false Pages SSG dynamic routes keep handler candidates for preview requests", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(
    context({
      pages: [
        {
          id: "/no-fallback/[post]",
          pathname: "/no-fallback/[post]",
          runtime: "nodejs",
          filePath: `${distDir}/server/pages/no-fallback/[post].js`,
        },
      ],
      prerenders: [
        {
          id: "/no-fallback/first",
          pathname: "/no-fallback/first",
          urlPath: "/no-fallback/first",
          filePath: `${distDir}/server/pages/no-fallback/first.html`,
        },
      ],
    }),
    {
      staticRoutes: [],
      dynamicPrerenderRoutes: [
        {
          page: "/no-fallback/[post]",
          routeRegex: "^/no\\-fallback/([^/]+?)(?:/)?$",
          dataRouteRegex: "^/_next/data/test-build/no\\-fallback/([^/]+?)\\.json$",
          fallback: false,
        },
      ],
      appPrerenderDataRoutes: [],
      pprSegmentPrefetchRoutes: [],
      prerenderResponseMeta: [],
    },
  );

  assert.deepEqual(
    routes.find((route) => route.id === "prerender-no-fallback-first"),
    {
      id: "prerender-no-fallback-first",
      pattern: "^/no-fallback/first$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/no-fallback/first",
    },
  );
  assert.deepEqual(
    routes.filter((route) => route.id === "no-fallback-_post_"),
    [
      {
        id: "no-fallback-_post_",
        pattern: "^/_next/data/test-build/no\\-fallback/([^/]+?)\\.json$",
        type: "page",
        runtime: "nodejs",
        params: ["post"],
        paramTypes: { post: "single" },
        previewOnly: true,
      },
      {
        id: "no-fallback-_post_",
        pattern: "^/no\\-fallback/([^/]+?)(?:/)?$",
        type: "page",
        runtime: "nodejs",
        params: ["post"],
        paramTypes: { post: "single" },
        previewOnly: true,
      },
    ],
  );
});

test("fallback false App SSG dynamic routes are static-path-only with bypass conditions", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(
    context({
      appPages: [
        {
          id: "/[locale].rsc",
          pathname: "/[locale].rsc",
          runtime: "nodejs",
          filePath: `${distDir}/server/app/[locale]/page.js`,
        },
        {
          id: "/[locale]",
          pathname: "/[locale]",
          runtime: "nodejs",
          filePath: `${distDir}/server/app/[locale]/page.js`,
        },
      ],
    }),
    {
      staticRoutes: [],
      dynamicPrerenderRoutes: [
        {
          page: "/[locale]",
          routeRegex: "^/([^/]+?)(?:/)?$",
          dataRouteRegex: "^/([^/]+?)\\.rsc$",
          fallback: false,
          bypass: [
            { type: "header", key: "next-action" },
            { type: "header", key: "content-type", value: "multipart/form-data;.*" },
          ],
        },
      ],
      appPrerenderDataRoutes: [],
      pprSegmentPrefetchRoutes: [],
      prerenderResponseMeta: [],
    },
  );

  assert.deepEqual(
    routes.filter((route) => route.id === "_locale__rsc" || route.id === "_locale_"),
    [
      {
        id: "_locale__rsc",
        pattern: "^\\/([^/]+?)\\.rsc(?:\\/)?$",
        type: "page",
        runtime: "nodejs",
        params: ["locale"],
        paramTypes: { locale: "single" },
        staticPathsOnly: true,
        prerenderBypass: [
          { type: "header", key: "next-action" },
          { type: "header", key: "content-type", value: "multipart/form-data;.*" },
        ],
      },
      {
        id: "_locale_",
        pattern: "^/([^/]+?)(?:/)?$",
        type: "page",
        runtime: "nodejs",
        params: ["locale"],
        paramTypes: { locale: "single" },
        staticPathsOnly: true,
        prerenderBypass: [
          { type: "header", key: "next-action" },
          { type: "header", key: "content-type", value: "multipart/form-data;.*" },
        ],
      },
    ],
  );
});

test("fallback-capable Pages SSG dynamic routes expose _next/data through the page handler", () => {
  const root = tempRoutingRoot("fallback-shell");
  const distDir = path.join(root, ".next");
  writeFile(path.join(distDir, "server", "pages", "[slug].html"));
  const routes = compileRouteTable(
    context({
      projectDir: root,
      pages: [
        {
          id: "/[slug]",
          pathname: "/[slug]",
          runtime: "nodejs",
          filePath: `${distDir}/server/pages/[slug].js`,
        },
      ],
    }),
    {
      staticRoutes: [],
      dynamicPrerenderRoutes: [
        {
          page: "/[slug]",
          routeRegex: "^/([^/]+?)(?:/)?$",
          dataRouteRegex: "^/_next/data/test-build/([^/]+?)\\.json$",
          fallback: "/[slug].html",
        },
      ],
      appPrerenderDataRoutes: [],
      pprSegmentPrefetchRoutes: [],
      prerenderResponseMeta: [],
    },
  );

  const firstHtmlRoute = routes.find((route) => new RegExp(route.pattern).test("/first"));
  assert.deepEqual(firstHtmlRoute, {
    id: "prerender-fallback-_slug_",
    pattern: "^\\/([^/]+?)(?:\\/)?$",
    type: "prerender",
    runtime: "nodejs",
    bundle: "",
    file: "/[slug]",
    headers: [{ key: "content-type", value: "text/html; charset=utf-8" }],
    pagesFallbackShell: true,
  });

  assert.deepEqual(
    routes.filter((route) => route.id === "_slug_"),
    [
      {
        id: "_slug_",
        pattern: "^/_next/data/test-build/([^/]+?)\\.json$",
        type: "page",
        runtime: "nodejs",
        params: ["slug"],
        paramTypes: { slug: "single" },
        deployPrerenderCacheControl: true,
      },
      {
        id: "_slug_",
        pattern: "^/([^/]+?)(?:/)?$",
        type: "page",
        runtime: "nodejs",
        params: ["slug"],
        paramTypes: { slug: "single" },
      },
    ],
  );
});

test("Pages SSG dynamic routes stay handler-only when the fallback shell artifact is absent", () => {
  const root = tempRoutingRoot("missing-fallback-shell");
  const distDir = path.join(root, ".next");
  const routes = compileRouteTable(
    context({
      projectDir: root,
      pages: [
        {
          id: "/[slug]",
          pathname: "/[slug]",
          runtime: "nodejs",
          filePath: `${distDir}/server/pages/[slug].js`,
        },
      ],
    }),
    {
      staticRoutes: [],
      dynamicPrerenderRoutes: [
        {
          page: "/[slug]",
          routeRegex: "^/([^/]+?)(?:/)?$",
          dataRouteRegex: "^/_next/data/test-build/([^/]+?)\\.json$",
          fallback: "/[slug].html",
        },
      ],
      appPrerenderDataRoutes: [],
      pprSegmentPrefetchRoutes: [],
      prerenderResponseMeta: [],
    },
  );

  assert.equal(
    routes.some((route) => route.id === "prerender-fallback-_slug_"),
    false,
  );
  assert.deepEqual(
    routes.filter((route) => route.id === "_slug_"),
    [
      {
        id: "_slug_",
        pattern: "^/_next/data/test-build/([^/]+?)\\.json$",
        type: "page",
        runtime: "nodejs",
        params: ["slug"],
        paramTypes: { slug: "single" },
        deployPrerenderCacheControl: true,
      },
      {
        id: "_slug_",
        pattern: "^/([^/]+?)(?:/)?$",
        type: "page",
        runtime: "nodejs",
        params: ["slug"],
        paramTypes: { slug: "single" },
      },
    ],
  );
});

test("literal bracket prerender paths are published as exact static routes", () => {
  const previousNow = Date.now;
  Date.now = () => 234_567;
  const distDir = "/tmp/brrrd-routing-test/.next";
  try {
    const routes = compileRouteTable(
      context({
        pages: [
          {
            id: "/dynamic/[slug]",
            pathname: "/dynamic/[slug]",
            runtime: "nodejs",
            filePath: `${distDir}/server/pages/dynamic/[slug].js`,
          },
        ],
        prerenders: [
          {
            id: "/dynamic/[first]",
            pathname: "/dynamic/[first]",
            urlPath: "/dynamic/[first]",
            filePath: `${distDir}/server/pages/dynamic/[first].html`,
            fallback: {
              initialRevalidate: false,
              initialHeaders: {
                "cache-control": "public, max-age=0, must-revalidate",
              },
            },
          },
          {
            id: "/_next/data/test-build/dynamic/[first].json",
            pathname: "/_next/data/test-build/dynamic/[first].json",
            urlPath: "/_next/data/test-build/dynamic/[first].json",
            filePath: `${distDir}/server/pages/dynamic/[first].json`,
            fallback: {
              initialRevalidate: false,
              initialHeaders: {
                "cache-control": "public, max-age=0, must-revalidate",
              },
            },
          },
          {
            id: "/dynamic/[slug]",
            pathname: "/dynamic/[slug]",
            urlPath: "/dynamic/[slug]",
          },
          {
            id: "/_next/data/test-build/dynamic/[slug].json",
            pathname: "/_next/data/test-build/dynamic/[slug].json",
            urlPath: "/_next/data/test-build/dynamic/[slug].json",
          },
        ],
      }),
      {
        staticRoutes: [],
        dynamicPrerenderRoutes: [
          {
            page: "/dynamic/[slug]",
            routeRegex: "^/dynamic/([^/]+?)(?:/)?$",
            dataRoute: "/_next/data/test-build/dynamic/[slug].json",
            dataRouteRegex: "^/_next/data/test-build/dynamic/([^/]+?)\\.json$",
            fallback: false,
          },
        ],
        appPrerenderDataRoutes: [],
        pprSegmentPrefetchRoutes: [],
        prerenderResponseMeta: [],
      },
    );

    assert.deepEqual(
      routes.find((route) => route.id === "prerender-dynamic-_first_"),
      {
        id: "prerender-dynamic-_first_",
        pattern: "^/dynamic/\\[first\\]$",
        type: "prerender",
        runtime: "nodejs",
        bundle: "",
        file: "/dynamic/[first]",
        headers: [{ key: "cache-control", value: "public, max-age=0, must-revalidate" }],
        isr: {
          initialRevalidate: false,
          generatedAtMs: 234_567,
        },
      },
    );
    assert.deepEqual(
      routes.find((route) => route.id === "prerender-_next-data-test-build-dynamic-_first__json"),
      {
        id: "prerender-_next-data-test-build-dynamic-_first__json",
        pattern: "^/_next/data/test-build/dynamic/\\[first\\]\\.json$",
        type: "prerender",
        runtime: "nodejs",
        bundle: "",
        file: "/_next/data/test-build/dynamic/[first].json",
        headers: [{ key: "cache-control", value: "public, max-age=0, must-revalidate" }],
        isr: {
          initialRevalidate: false,
          generatedAtMs: 234_567,
        },
      },
    );
    assert.equal(routes.some((route) => route.id === "prerender-dynamic-_slug_"), false);
    assert.equal(
      routes.some((route) => route.id === "prerender-_next-data-test-build-dynamic-_slug__json"),
      false,
    );
  } finally {
    Date.now = previousNow;
  }
});

test("pagesApi outputs outside the /api boundary are normalized as Pages routes", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const model = context({
    pagesApi: [
      {
        id: "/api-docs/[...slug]",
        pathname: "/api-docs/[...slug]",
        runtime: "nodejs",
        filePath: `${distDir}/server/pages/api-docs/[...slug].js`,
      },
      {
        id: "/api/hello",
        pathname: "/api/hello",
        runtime: "nodejs",
        filePath: `${distDir}/server/pages/api/hello.js`,
      },
    ],
  });

  assert.equal(model.outputs.pages.some((page) => page.pathname === "/api-docs/[...slug]"), true);
  assert.equal(model.outputs.pagesApi.some((api) => api.pathname === "/api-docs/[...slug]"), false);
  assert.equal(model.outputs.pagesApi.some((api) => api.pathname === "/api/hello"), true);
});

test("Pages SSG dynamic fallback shells use index storage when public children exist", () => {
  const root = tempRoutingRoot("fallback-shell-child");
  const distDir = path.join(root, ".next");
  writeFile(path.join(distDir, "server", "pages", "blog", "[post].html"));
  const routes = compileRouteTable(
    context({
      projectDir: root,
      pages: [
        {
          id: "/blog/[post]",
          pathname: "/blog/[post]",
          runtime: "nodejs",
          filePath: `${distDir}/server/pages/blog/[post].js`,
        },
      ],
      staticFiles: [
        {
          id: "/blog/[post]/comments",
          pathname: "/blog/[post]/comments",
          urlPath: "/blog/[post]/comments",
          filePath: `${distDir}/static/blog-comment.html`,
        },
      ],
    }),
    {
      staticRoutes: [],
      dynamicPrerenderRoutes: [
        {
          page: "/blog/[post]",
          routeRegex: "^/blog/([^/]+?)(?:/)?$",
          dataRouteRegex: "^/_next/data/test-build/blog/([^/]+?)\\.json$",
          fallback: "/blog/[post].html",
        },
      ],
      appPrerenderDataRoutes: [],
      pprSegmentPrefetchRoutes: [],
      prerenderResponseMeta: [],
    },
  );

  assert.deepEqual(
    routes.find((route) => route.id === "prerender-fallback-blog-_post_"),
    {
      id: "prerender-fallback-blog-_post_",
      pattern: "^\\/blog\\/([^/]+?)(?:\\/)?$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/blog/[post]/index",
      headers: [{ key: "content-type", value: "text/html; charset=utf-8" }],
      pagesFallbackShell: true,
    },
  );
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
  assert.deepEqual(
    routes.find((route) => route.id === "pages-static-data-index"),
    {
      id: "pages-static-data-index",
      pattern: "^/_next/data/test-build/index\\.json$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/_next/data/test-build/index.json",
    },
  );
});

test("static Pages Router index HTML preserves basePath on the public root path", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(context({
    config: { basePath: "/docs" },
    staticFiles: [
      staticFile("/docs/index", `${distDir}/server/pages/index.html`),
      staticFile("/docs/nested/index", `${distDir}/server/pages/nested/index.html`),
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "static-docs"),
    {
      id: "static-docs",
      pattern: "^/docs$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/docs/index",
      immutable: false,
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "static-docs-nested"),
    {
      id: "static-docs-nested",
      pattern: "^/docs/nested$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/docs/nested/index",
      immutable: false,
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "pages-static-data-docs"),
    {
      id: "pages-static-data-docs",
      pattern: "^/docs/_next/data/test-build/index\\.json$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/docs/_next/data/test-build/index.json",
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "pages-static-data-docs-nested"),
    {
      id: "pages-static-data-docs-nested",
      pattern: "^/docs/_next/data/test-build/nested\\.json$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/docs/_next/data/test-build/nested.json",
    },
  );
});

test("Next image optimizer is emitted as an internal filesystem route", () => {
  const routes = compileRouteTable(context({}));

  assert.deepEqual(
    routes.find((route) => route.id === "_next_image"),
    {
      id: "_next_image",
      pattern: "^/_next/image(?:/)?$",
      type: "image-optimizer",
      runtime: "nodejs",
      bundle: "",
    },
  );

  const staticIndex = routes.findIndex((route) => route.id === "_next_static");
  const imageIndex = routes.findIndex((route) => route.id === "_next_image");
  const pageIndex = routes.findIndex((route) => route.type === "page");
  assert.ok(staticIndex >= 0);
  assert.ok(imageIndex > staticIndex);
  if (pageIndex >= 0) assert.ok(imageIndex < pageIndex);
});

test("Next image optimizer route follows configured basePath", () => {
  const routes = compileRouteTable(context({
    config: { basePath: "/docs" },
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "_next_image"),
    {
      id: "_next_image",
      pattern: "^/docs/_next/image(?:/)?$",
      type: "image-optimizer",
      runtime: "nodejs",
      bundle: "",
    },
  );
});

test("routing manifest carries basePath independently from i18n", () => {
  const routing = compileRouting(context({
    config: { basePath: "/docs" },
  }));

  assert.equal(routing.basePath, "/docs");
  assert.equal(routing.i18n, undefined);
});

test("routing manifest carries trailingSlash for middleware data URL normalization", () => {
  const routing = compileRouting(context({
    config: { trailingSlash: true },
  }));

  assert.equal(routing.trailingSlash, true);
});

test("executable Pages Router index handlers are exposed at public index paths", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(context({
    pages: [
      appPage("/index", `${distDir}/server/pages/index.js`),
      appPage("/nested/index", `${distDir}/server/pages/nested/index.js`),
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "index"),
    {
      id: "index",
      pattern: "^/$",
      type: "page",
      runtime: "nodejs",
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "nested-index"),
    {
      id: "nested-index",
      pattern: "^/nested$",
      type: "page",
      runtime: "nodejs",
    },
  );
});

test("executable Pages Router index handlers preserve basePath on public index paths", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(context({
    config: { basePath: "/docs" },
    pages: [
      appPage("/docs/index", `${distDir}/server/pages/index.js`),
      appPage("/docs/nested/index", `${distDir}/server/pages/nested/index.js`),
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "docs-index"),
    {
      id: "docs-index",
      pattern: "^/docs$",
      type: "page",
      runtime: "nodejs",
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "docs-nested-index"),
    {
      id: "docs-nested-index",
      pattern: "^/docs/nested$",
      type: "page",
      runtime: "nodejs",
    },
  );
});

test("literal Pages Router index routes are not collapsed to their parent path", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(context({
    pages: [
      appPage("/nested/index", `${distDir}/server/pages/nested/index/index.js`),
    ],
    staticFiles: [
      staticFile("/static/index", `${distDir}/server/pages/static/index/index.html`),
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "nested-index"),
    {
      id: "nested-index",
      pattern: "^/nested/index$",
      type: "page",
      runtime: "nodejs",
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "static-static-index"),
    {
      id: "static-static-index",
      pattern: "^/static/index$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/static/index",
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

test("PPR app prerenders are marked so runtime can apply document routing policy", () => {
  const routes = compileRouteTable(
    context({
      appPages: [appPage("/")],
      prerenders: [
        {
          id: "/",
          pathname: "/",
          parentOutputId: "/",
        },
      ],
    }),
    {
      staticRoutes: [],
      dynamicPrerenderRoutes: [],
      appPrerenderDataRoutes: [],
      pprSegmentPrefetchRoutes: [],
      prerenderResponseMeta: [],
      pprPages: ["/"],
    },
  );

  assert.deepEqual(
    routes.find((route) => route.id === "prerender-index"),
    {
      id: "prerender-index",
      pattern: "^/$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/",
      ppr: true,
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

test("static App prerender routes keep server action bypass metadata", () => {
  const routes = compileRouteTable(
    context({
      appPages: [appPage("/")],
      prerenders: [
        {
          id: "/",
          pathname: "/",
          parentOutputId: "/",
        },
      ],
    }),
    {
      staticRoutes: [],
      dynamicPrerenderRoutes: [],
      appPrerenderDataRoutes: [],
      pprSegmentPrefetchRoutes: [],
      prerenderResponseMeta: [{
        pathname: "/",
        headers: [{ key: "x-nextjs-prerender", value: "1" }],
        prerenderBypass: [
          { type: "header", key: "next-action" },
          { type: "header", key: "content-type", value: "multipart/form-data;.*" },
        ],
      }],
    },
  );

  assert.deepEqual(
    routes.find((route) => route.id === "prerender-index"),
    {
      id: "prerender-index",
      pattern: "^/$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/",
      headers: [{ key: "x-nextjs-prerender", value: "1" }],
      prerenderBypass: [
        { type: "header", key: "next-action" },
        { type: "header", key: "content-type", value: "multipart/form-data;.*" },
      ],
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
      appPage("/edge/[[...slug]]"),
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
      paramTypes: { id: "single" },
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
      paramTypes: { slug: "catchAll" },
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "edge-_____slug__"),
    {
      id: "edge-_____slug__",
      pattern: "^\\/edge(?:\\/(.+?))?(?:\\/)?$",
      type: "page",
      runtime: "nodejs",
      params: ["slug"],
      paramTypes: { slug: "optionalCatchAll" },
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
      headers: [{ key: "content-type", value: "text/html; charset=utf-8" }],
      params: ["post"],
      paramTypes: { post: "single" },
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
      headers: [{ key: "content-type", value: "text/html; charset=utf-8" }],
      params: ["post"],
      paramTypes: { post: "single" },
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
      { id: "/en", pathname: "/en" },
      { id: "/en/posts/a", pathname: "/en/posts/a" },
      {
        id: "/_next/data/test-build/en.json",
        pathname: "/_next/data/test-build/en.json",
      },
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
    routes.find((route) => route.id === "prerender-en-default-locale-alias"),
    {
      id: "prerender-en-default-locale-alias",
      pattern: "^/$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/en/index",
    },
  );
  assert.deepEqual(
    routes.find((route) => (
      route.id === "prerender-_next-data-test-build-en_json-default-locale-alias"
    )),
    {
      id: "prerender-_next-data-test-build-en_json-default-locale-alias",
      pattern: "^/_next/data/test-build/index\\.json$",
      type: "prerender",
      runtime: "nodejs",
      bundle: "",
      file: "/_next/data/test-build/en.json",
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

test("i18n default-locale static routes preserve basePath on public aliases", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(context({
    config: {
      basePath: "/basepath",
      i18n: { locales: ["en", "fr"], defaultLocale: "en" },
    },
    staticFiles: [
      staticFile("/basepath/en", `${distDir}/server/pages/en.html`),
      staticFile("/basepath/en/newpage", `${distDir}/server/pages/en/newpage.html`),
      staticFile(
        "/basepath/_next/data/test-build/en/newpage.json",
        `${distDir}/server/pages/en/newpage.json`,
      ),
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "static-basepath-en-default-locale-alias"),
    {
      id: "static-basepath-en-default-locale-alias",
      pattern: "^/basepath$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/basepath/en/index",
      immutable: false,
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "static-basepath-en-newpage-default-locale-alias"),
    {
      id: "static-basepath-en-newpage-default-locale-alias",
      pattern: "^/basepath/newpage$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/basepath/en/newpage",
      immutable: false,
    },
  );
  assert.deepEqual(
    routes.find((route) => (
      route.id === "static-basepath-_next-data-test-build-en-newpage_json-default-locale-alias"
    )),
    {
      id: "static-basepath-_next-data-test-build-en-newpage_json-default-locale-alias",
      pattern: "^/basepath/_next/data/test-build/newpage\\.json$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/basepath/_next/data/test-build/en/newpage.json",
      immutable: false,
    },
  );
});

test("i18n default-locale dynamic static aliases preserve route params", () => {
  const distDir = "/tmp/brrrd-routing-test/.next";
  const routes = compileRouteTable(context({
    config: { i18n: { locales: ["en", "fr"], defaultLocale: "en" } },
    staticFiles: [
      staticFile("/en/detail/[...slug]", `${distDir}/server/pages/en/detail/[...slug].html`),
      staticFile(
        "/_next/data/test-build/en/detail/[...slug].json",
        `${distDir}/server/pages/en/detail/[...slug].json`,
      ),
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "static-en-detail-____slug_-default-locale-alias"),
    {
      id: "static-en-detail-____slug_-default-locale-alias",
      pattern: "^\\/detail\\/(.+?)(?:\\/)?$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/en/detail/[...slug]",
      immutable: false,
      headers: [{ key: "content-type", value: "text/html; charset=utf-8" }],
      params: ["slug"],
      paramTypes: { slug: "catchAll" },
      localeHandling: "unprefixed",
    },
  );
  assert.deepEqual(
    routes.find((route) => (
      route.id === "static-_next-data-test-build-en-detail-____slug__json-default-locale-alias"
    )),
    {
      id: "static-_next-data-test-build-en-detail-____slug__json-default-locale-alias",
      pattern: "^\\/_next\\/data\\/test\\-build\\/detail\\/(.+?)\\.json(?:\\/)?$",
      type: "static",
      runtime: "nodejs",
      bundle: "",
      file: "/_next/data/test-build/en/detail/[...slug].json",
      immutable: false,
      params: ["slug"],
      paramTypes: { slug: "catchAll" },
      localeHandling: "unprefixed",
    },
  );
});

test("i18n default-locale page handlers are exposed at public unprefixed paths", () => {
  const routes = compileRouteTable(context({
    config: { i18n: { locales: ["en", "fr"], defaultLocale: "en" } },
    pages: [
      appPage("/en"),
      appPage("/fr"),
      appPage("/_next/data/test-build/en.json"),
      appPage("/_next/data/test-build/fr.json"),
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "en" && route.pattern === "^/$"),
    {
      id: "en",
      pattern: "^/$",
      type: "page",
      runtime: "nodejs",
    },
  );
  assert.deepEqual(
    routes.find((route) => (
      route.id === "_next-data-test-build-en_json"
      && route.pattern === "^/_next/data/test-build/index\\.json$"
    )),
    {
      id: "_next-data-test-build-en_json",
      pattern: "^/_next/data/test-build/index\\.json$",
      type: "page",
      runtime: "nodejs",
    },
  );
  assert.equal(
    routes.some((route) => route.id === "fr" && route.pattern === "^/$"),
    false,
  );
});

test("i18n default-locale dynamic page handlers are exposed at public unprefixed paths", () => {
  const routes = compileRouteTable(context({
    config: { i18n: { locales: ["en", "fr"], defaultLocale: "en" } },
    pages: [
      appPage("/dynamic/[slug]"),
      appPage("/en/dynamic/[slug]"),
      appPage("/fr/dynamic/[slug]"),
    ],
    dynamicRoutes: [
      {
        source: "/dynamic/[slug]",
        sourceRegex: "^[/]?(?<nextLocale>[^/]{1,})/dynamic/(?<nxtPslug>[^/]+?)(?:/)?$",
        destination: "/:nextInternalLocale/dynamic/[slug]",
      },
    ],
  }));

  const localized = routes.find((route) => route.id === "dynamic-_slug_");
  assert.deepEqual(localized, {
    id: "dynamic-_slug_",
    pattern: "^[/]?(?<nextLocale>[^/]{1,})/dynamic/(?<nxtPslug>[^/]+?)(?:/)?$",
    type: "page",
    runtime: "nodejs",
    params: ["slug"],
    paramTypes: { slug: "single" },
  });

  const defaultAlias = routes.find((route) => (
    route.id === "en-dynamic-_slug_"
    && new RegExp(route.pattern).test("/dynamic/new")
  ));
  assert.ok(defaultAlias);
  assert.deepEqual(defaultAlias, {
    id: "en-dynamic-_slug_",
    pattern: defaultAlias.pattern,
    type: "page",
    runtime: "nodejs",
    params: ["slug"],
    paramTypes: { slug: "single" },
    localeHandling: "unprefixed",
  });
});

test("i18n default-locale dynamic Pages API handlers are exposed at public unprefixed paths", () => {
  const routes = compileRouteTable(context({
    config: { i18n: { locales: ["en", "fr"], defaultLocale: "en" } },
    pagesApi: [
      appPage("/api/blog/[slug]"),
    ],
    dynamicRoutes: [
      {
        source: "/api/blog/[slug]",
        sourceRegex: "^[/]?(?<nextLocale>[^/]{1,})/api/blog/(?<nxtPslug>[^/]+?)(?:/)?$",
        destination: "/:nextInternalLocale/api/blog/[slug]",
      },
    ],
  }));

  assert.deepEqual(
    routes.find((route) => (
      route.id === "api-blog-_slug_"
      && route.pattern === "^[/]?(?<nextLocale>[^/]{1,})/api/blog/(?<nxtPslug>[^/]+?)(?:/)?$"
    )),
    {
      id: "api-blog-_slug_",
      pattern: "^[/]?(?<nextLocale>[^/]{1,})/api/blog/(?<nxtPslug>[^/]+?)(?:/)?$",
      type: "route",
      runtime: "nodejs",
      params: ["slug"],
      paramTypes: { slug: "single" },
    },
  );

  const defaultAlias = routes.find((route) => (
    route.id === "api-blog-_slug_"
    && new RegExp(route.pattern).test("/api/blog/first")
  ));
  assert.ok(defaultAlias);
  assert.deepEqual(defaultAlias, {
    id: "api-blog-_slug_",
    pattern: defaultAlias.pattern,
    type: "route",
    runtime: "nodejs",
    params: ["slug"],
    paramTypes: { slug: "single" },
    localeHandling: "unprefixed",
  });
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

test("public intercepting route handlers carry route metadata", () => {
  const routes = compileRouteTable(context({
    appPages: [
      appPage("/post/[id]"),
      appPage("/foo/(...)post/[id]"),
      appPage("/foo/(...)post/[id].rsc"),
    ],
    dynamicRoutes: [
      {
        source: "/foo/(...)post/[id]",
        sourceRegex: "^/foo/\\(\\.\\.\\.\\)post/(?<nxtPid>[^/]+?)(?:/)?$",
        destination: "/foo/(...)post/[id]?nxtPid=$nxtPid",
      },
      {
        source: "/foo/(...)post/[id].rsc",
        sourceRegex: "^/foo/\\(\\.\\.\\.\\)post/(?<nxtPid>[^/]+?)(?<rscSuffix>\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$",
        destination: "/foo/(...)post/[id]$rscSuffix?nxtPid=$nxtPid",
      },
    ],
  }));

  assert.deepEqual(
    routes.find((route) => route.id === "foo-(___)post-_id_"),
    {
      id: "foo-(___)post-_id_",
      pattern: "^/foo/\\(\\.\\.\\.\\)post/(?<nxtPid>[^/]+?)(?:/)?$",
      type: "page",
      runtime: "nodejs",
      params: ["id"],
      paramTypes: { id: "single" },
      intercepted: true,
    },
  );
  assert.deepEqual(
    routes.find((route) => route.id === "foo-(___)post-_id__rsc"),
    {
      id: "foo-(___)post-_id__rsc",
      pattern: "^/foo/\\(\\.\\.\\.\\)post/(?<nxtPid>[^/]+?)(?<rscSuffix>\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$",
      type: "page",
      runtime: "nodejs",
      params: ["id"],
      paramTypes: { id: "single" },
      intercepted: true,
    },
  );
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
      prerenders: [
        {
          id: "/[slug].segments/$d$slug/__PAGE__.segment.rsc",
          pathname: "/[slug].segments/$d$slug/__PAGE__.segment.rsc",
          fallback: {
            initialHeaders: {
              vary: "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch",
              "content-type": "text/x-component",
              "x-nextjs-postponed": "2",
            },
          },
          config: {
            allowQuery: [],
          },
        },
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
    file: "/[slug].segments/$d$slug$segment",
    params: ["path"],
    headers: [
      {
        key: "vary",
        value: "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch",
      },
      { key: "content-type", value: "text/x-component" },
      { key: "x-nextjs-postponed", value: "2" },
    ],
    allowQuery: [],
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

test("PPR RSC prerenders attach resume metadata to the handler route", () => {
  const routes = compileRouteTable(
    context({
      appPages: [
        appPage("/dynamic.rsc"),
      ],
      prerenders: [
        {
          id: "/dynamic.rsc",
          pathname: "/dynamic.rsc",
          pprChain: {
            headers: {
              "next-resume": "1",
            },
          },
          fallback: {
            postponedState: "postponed-state",
          },
        },
      ],
    }),
  );

  assert.deepEqual(
    routes.find((route) => route.id === "dynamic_rsc"),
    {
      id: "dynamic_rsc",
      pattern: "^/dynamic\\.rsc$",
      type: "page",
      runtime: "nodejs",
      pprResume: {
        headers: {
          "next-resume": "1",
        },
        postponedState: "postponed-state",
      },
    },
  );
});

test("dynamic PPR app routes preserve fallback route params for runtime app-shell prefetch", () => {
  const routes = compileRouteTable(
    context({
      appPages: [
        appPage("/[teamSlug]/[project].rsc"),
      ],
      dynamicRoutes: [
        {
          source: "/[teamSlug]/[project].rsc",
          sourceRegex: "^/(?<nxtPteamSlug>[^/]+?)/(?<nxtPproject>[^/]+?)\\.rsc(?:/)?$",
          destination: "/[teamSlug]/[project].rsc",
        },
      ],
    }),
    {
      staticRoutes: [],
      dynamicPrerenderRoutes: [
        {
          page: "/[teamSlug]/[project]",
          routeRegex: "^/([^/]+?)/([^/]+?)(?:/)?$",
          dataRouteRegex: "^/([^/]+?)/([^/]+?)\\.rsc$",
          fallback: "/[teamSlug]/[project]",
          bypass: [],
          fallbackRouteParams: [
            { paramName: "teamSlug", paramType: "dynamic" },
            { paramName: "project", paramType: "dynamic" },
          ],
        },
      ],
      appPrerenderDataRoutes: [],
      pprSegmentPrefetchRoutes: [],
    },
  );

  assert.deepEqual(
    routes.find((route) => route.id === "_teamSlug_-_project__rsc"),
    {
      id: "_teamSlug_-_project__rsc",
      pattern: "^/(?<nxtPteamSlug>[^/]+?)/(?<nxtPproject>[^/]+?)\\.rsc(?:/)?$",
      type: "page",
      runtime: "nodejs",
      params: ["teamSlug", "project"],
      paramTypes: {
        teamSlug: "single",
        project: "single",
      },
      pprFallbackRouteParams: [
        { paramName: "teamSlug", paramType: "dynamic" },
        { paramName: "project", paramType: "dynamic" },
      ],
    },
  );
});

test("App prerender RSC data artifacts are exact static routes before dynamic RSC handlers", () => {
  const routes = compileRouteTable(
    context({
      appPages: [
        appPage("/[slug].rsc"),
      ],
      prerenders: [
        {
          id: "/alpha.rsc",
          pathname: "/alpha.rsc",
          fallback: {
            initialStatus: 203,
            initialHeaders: {
              "content-type": "text/x-component",
              "x-nextjs-postponed": "2",
            },
          },
          config: {
            allowQuery: [],
          },
        },
        {
          id: "/alpha.segments/_tree.segment.rsc",
          pathname: "/alpha.segments/_tree.segment.rsc",
          fallback: {
            initialHeaders: {
              "content-type": "text/x-component",
              "x-nextjs-postponed": "2",
            },
          },
          config: {
            allowQuery: [],
          },
        },
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
      status: 203,
      headers: [
        { key: "content-type", value: "text/x-component" },
        { key: "x-nextjs-postponed", value: "2" },
      ],
      allowQuery: [],
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
      headers: [
        { key: "content-type", value: "text/x-component" },
        { key: "x-nextjs-postponed", value: "2" },
      ],
      allowQuery: [],
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

test("concrete App prerender segment data wins over dynamic segment templates", () => {
  const routes = compileRouteTable(
    context({
      appPages: [
        appPage("/test-dynamic/[slug].rsc"),
      ],
      prerenders: [
        {
          id: "/test-dynamic/[slug].segments/_tree.segment.rsc",
          pathname: "/test-dynamic/[slug].segments/_tree.segment.rsc",
          fallback: {
            initialHeaders: {
              vary: "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch",
              "content-type": "text/x-component",
              "x-nextjs-postponed": "2",
            },
          },
          config: {
            allowQuery: ["slug"],
          },
        },
      ],
      dynamicRoutes: [
        {
          source: "/test-dynamic/[slug].rsc",
          sourceRegex: "^/test-dynamic/(?<nxtPslug>[^/]+?)(?<rscSuffix>\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$",
          destination: "/test-dynamic/[slug].rsc",
        },
      ],
    }),
    {
      staticRoutes: [],
      dynamicPrerenderRoutes: [
        {
          page: "/test-dynamic/[slug]",
          routeRegex: "^/test-dynamic/([^/]+?)(?:/)?$",
          dataRouteRegex: "^/test-dynamic/([^/]+?)\\.rsc$",
          fallback: "/test-dynamic/[slug].html",
        },
      ],
      appPrerenderDataRoutes: [
        {
          pathname: "/test-dynamic/[slug].segments/_tree.segment.rsc",
          sourceRel: "test-dynamic/[slug].segments/_tree.segment.rsc",
        },
        {
          pathname: "/test-dynamic/hello.segments/_tree.segment.rsc",
          sourceRel: "test-dynamic/hello.segments/_tree.segment.rsc",
        },
      ],
      pprSegmentPrefetchRoutes: [],
    },
  );

  const concreteIndex = routes.findIndex((route) => (
    route.id === "app-prerender-data-test-dynamic-hello_segments-_tree_segment_rsc"
  ));
  const dynamicTemplateIndex = routes.findIndex((route) => (
    route.id === "app-prerender-data-dynamic-test-dynamic-_slug__segments-_tree_segment_rsc"
  ));
  const dynamicRscIndex = routes.findIndex((route) => route.id === "test-dynamic-_slug__rsc");
  assert.ok(concreteIndex >= 0);
  assert.ok(dynamicTemplateIndex >= 0);
  assert.ok(dynamicRscIndex >= 0);
  assert.ok(concreteIndex < dynamicTemplateIndex);
  assert.ok(dynamicTemplateIndex < dynamicRscIndex);
  assert.deepEqual(routes[dynamicTemplateIndex].headers, [
    {
      key: "vary",
      value: "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch",
    },
    { key: "content-type", value: "text/x-component" },
    { key: "x-nextjs-postponed", value: "2" },
  ]);
  assert.deepEqual(routes[dynamicTemplateIndex].allowQuery, ["slug"]);

  const firstConcreteSegmentMatch = routes.find((route) => (
    new RegExp(route.pattern).test("/test-dynamic/hello.segments/_tree.segment.rsc")
  ));
  assert.equal(
    firstConcreteSegmentMatch.id,
    "app-prerender-data-test-dynamic-hello_segments-_tree_segment_rsc",
  );
});

test("more specific dynamic App prerender segment data wins over generic templates", () => {
  const routes = compileRouteTable(
    context({
      appPages: [
        appPage("/instant-loading/[category]/[itemId].rsc"),
      ],
    }),
    {
      staticRoutes: [],
      dynamicPrerenderRoutes: [
        {
          page: "/instant-loading/[category]/[itemId]",
          routeRegex: "^/instant-loading/([^/]+?)/([^/]+?)(?:/)?$",
          dataRouteRegex: "^/instant-loading/([^/]+?)/([^/]+?)\\.rsc$",
          fallback: "/instant-loading/[category]/[itemId].html",
        },
        {
          page: "/instant-loading/electronics/[itemId]",
          routeRegex: "^/instant-loading/electronics/([^/]+?)(?:/)?$",
          dataRouteRegex: "^/instant-loading/electronics/([^/]+?)\\.rsc$",
          fallback: "/instant-loading/electronics/[itemId].html",
        },
      ],
      appPrerenderDataRoutes: [
        {
          pathname: "/instant-loading/[category]/[itemId].segments/!root/instant-loading/$d$category.segment.rsc",
          sourceRel: "instant-loading/[category]/[itemId].segments/!root/instant-loading/$d$category.segment.rsc",
        },
        {
          pathname: "/instant-loading/electronics/[itemId].segments/!root/instant-loading/$d$category.segment.rsc",
          sourceRel: "instant-loading/electronics/[itemId].segments/!root/instant-loading/$d$category.segment.rsc",
        },
      ],
      pprSegmentPrefetchRoutes: [],
    },
  );

  const firstCategorySegmentMatch = routes.find((route) => (
    new RegExp(route.pattern).test(
      "/instant-loading/electronics/phone.segments/!root/instant-loading/$d$category.segment.rsc",
    )
  ));

  assert.equal(
    firstCategorySegmentMatch.id,
    "app-prerender-data-dynamic-instant-loading-electronics-_itemId__segments-!root-instant-loading-$d$category_segment_rsc",
  );
});
