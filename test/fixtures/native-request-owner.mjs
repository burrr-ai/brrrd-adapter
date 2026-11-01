// Unit-only model of the runtime's current-request work owner. Real ownership
// is accepted separately through the actual Fleet native regression suites.
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerHooks } from 'node:module';

const scope = new AsyncLocalStorage();
export const registeredWork = [];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') {
      return { url: new URL('./cloudflare-workers.mjs', import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export function waitUntil(promise) {
  registeredWork.push(promise);
  // The runtime observes rejection of owned work; preserve the original promise.
  promise.catch(() => {});
  scope.getStore()?.(promise);
}

export function runNativeRequest(context, callback) {
  const owner = typeof context?.waitUntil === 'function' ? context.waitUntil.bind(context) : undefined;
  return scope.run(owner, callback);
}

export async function loadNativeBundle(url) {
  const app = await import(url);
  if (!String(url).endsWith('/bundles/app.js')) return app;
  return {
    ...app,
    default: (...args) => runNativeRequest(args[1]?.cloudflare?.ctx, () => app.default(...args)),
    proxy: (...args) => runNativeRequest(args[2], () => app.proxy(...args)),
  };
}
