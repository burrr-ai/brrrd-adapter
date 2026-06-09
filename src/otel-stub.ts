// TD-11: OpenTelemetry API stub. Next.js tracer requires `@opentelemetry/api`, but
// in production it will be replaced by brrrd's own OTel pipeline (B-2). This is a
// no-op fallback for when the user has not added a separate otel SDK as a dependency.
//
// Why this is split out: to keep REQUIRE_BANNER in bundler.ts from bloating, and to
// isolate the stub in its own module so that future stub behavior (e.g. swapping the
// noop tracer for the real otel global) is easy to replace.

export const OTEL_STUB_SOURCE = `(() => {
  const noopSpan = { end(){}, setAttribute(){}, setStatus(){}, recordException(){}, isRecording(){ return false; } };
  const noopTracer = {
    startSpan: () => noopSpan,
    startActiveSpan: (n, o, f) => {
      if (typeof o === "function") { f = o; o = undefined; }
      return typeof f === "function" ? f(noopSpan) : noopSpan;
    },
  };
  const noopCtx = { getValue(){ return undefined; }, setValue(){ return this; }, deleteValue(){ return this; } };
  return {
    trace: {
      getTracer: () => noopTracer,
      getSpan: () => undefined,
      getActiveSpan: () => undefined,
      setSpan: (ctx) => ctx,
      deleteSpan: (ctx) => ctx,
    },
    context: {
      active: () => noopCtx,
      with: (c, f, t, ...a) => f.call(t, ...a),
      bind: (c, f) => f,
    },
    SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
    createContextKey: (name) => Symbol(name),
    propagation: { extract: (c) => c, inject: () => {} },
    ROOT_CONTEXT: noopCtx,
    SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2 },
    diag: { setLogger(){}, verbose(){}, debug(){}, info(){}, warn(){}, error(){} },
  };
})()`;
