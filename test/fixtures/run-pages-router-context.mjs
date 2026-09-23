import { AsyncLocalStorage } from "node:async_hooks";
import { builtinModules, createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

// Next expects the runtime to install this before any App Router storage module
// is evaluated, including cache-handler dependencies loaded by a Pages bundle.
globalThis.AsyncLocalStorage = AsyncLocalStorage;
globalThis.__brrrd_modules = {};
for (const builtin of builtinModules) {
  if (builtin.startsWith("_")) continue;
  try {
    const mod = require(builtin);
    globalThis.__brrrd_modules[builtin] = mod;
    if (!builtin.startsWith("node:")) {
      globalThis.__brrrd_modules[`node:${builtin}`] = mod;
    }
  } catch {
    // Some Node builtins are compile-time aliases only.
  }
}

const { default: dispatch } = await import(pathToFileURL(process.argv[2]));
let body = "";
await dispatch(
  "/",
  { headers: { host: "localhost" }, __brrrd_request_meta: {} },
  {
    end(chunk = "") {
      body += String(chunk);
    },
    writeHead() {},
  },
);
process.stdout.write(body);
