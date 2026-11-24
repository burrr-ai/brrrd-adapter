import * as fs from "node:fs";
import * as path from "node:path";

import type { AdapterBuildContext } from "./model.js";

type Output = AdapterBuildContext["outputs"]["pages"][number];
type OutputKind = "appPages" | "appRoutes" | "pages" | "pagesApi" | "middleware";

const OUTPUT_KINDS: Record<string, OutputKind> = {
  APP_PAGE: "appPages",
  APP_ROUTE: "appRoutes",
  PAGES: "pages",
  PAGES_API: "pagesApi",
  MIDDLEWARE: "middleware",
};

function diagnostic(output: Output, collection: string): string {
  const kind = output.type === undefined
    ? Object.values(OUTPUT_KINDS).find((value) => value === collection)
    : OUTPUT_KINDS[output.type];
  // Only Next's output kind determines the migration advice. In particular,
  // a URL that happens to contain /api is not evidence of a Pages API handler.
  const label = output.sourcePage || output.pathname || output.id;
  const target = `${label} [${output.id}]`;
  switch (kind) {
    case "appPages":
    case "appRoutes":
      return `  - App Router ${kind === "appPages" ? "page" : "route"} ${target}: Remove runtime = 'edge' or set it to 'nodejs' (including inherited layout config).`;
    case "pages":
      return `  - Pages Router page ${target}: Remove the Edge/experimental-edge runtime declaration.`;
    case "pagesApi":
      return `  - Pages Router Edge API ${target}: Convert to a (req, res) handler or migrate to an App Router route handler; removing the runtime declaration alone is not enough.`;
    case "middleware":
      return `  - Edge middleware ${target}: Rename middleware.ts to proxy.ts (and the middleware export to proxy), or set config.runtime = 'nodejs'.`;
    default:
      return `  - Edge output [${output.id}]: Configure this output to use the Node runtime.`;
  }
}

/** Admit only Next's Node outputs, before touching the deployment package. */
export function assertNodeRuntime(ctx: AdapterBuildContext): void {
  const errors = new Set<string>();
  for (const [collection, value] of Object.entries(ctx.outputs)) {
    const outputs: Output[] = Array.isArray(value) ? value : value ? [value] : [];
    for (const output of outputs) {
      if (
        output.runtime === "edge"
        || output.runtime === "experimental-edge"
        || output.edgeRuntime != null
        || (collection === "middleware" && output.runtime !== "nodejs")
      ) {
        errors.add(diagnostic(output, collection));
      }
    }
  }

  // Next emits legacy Edge middleware here, whereas Node middleware/proxy is
  // described by outputs.middleware. Inspect metadata only, never user source
  // or chunk contents. The Adapter API remains authoritative when present.
  if (!ctx.outputs.middleware) {
    const manifestPath = path.join(ctx.distDir, "server", "middleware-manifest.json");
    let middleware: Record<string, unknown> | undefined;
    try {
      middleware = JSON.parse(fs.readFileSync(manifestPath, "utf8"))?.middleware;
    } catch {
      // A missing/unreadable supplement does not hide known API diagnostics.
    }
    if (middleware && typeof middleware === "object") {
      for (const id of Object.keys(middleware)) {
        errors.add(diagnostic({ id, pathname: id }, "middleware"));
      }
    }
  }

  if (errors.size > 0) {
    throw new Error([
      "brrrd 0.2.x runs on the Node runtime only; Edge runtime is not supported.",
      ...errors,
    ].join("\n"));
  }
}
