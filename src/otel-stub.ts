// Next's server runtime expects the stable OpenTelemetry API surface even when an
// application has not installed an SDK. brrrd supplies a no-op implementation so
// tracing hooks stay inert instead of crashing request handling.

export const OTEL_STUB_SOURCE = `(() => {
  const noopSpanContext = undefined;
  const noopSpan = {
    end(){},
    setAttribute(){ return this; },
    setAttributes(){ return this; },
    setStatus(){ return this; },
    updateName(){ return this; },
    addEvent(){ return this; },
    addLink(){ return this; },
    addLinks(){ return this; },
    recordException(){ return this; },
    isRecording(){ return false; },
    spanContext(){ return noopSpanContext; },
  };
  const noopTracer = {
    startSpan: () => noopSpan,
    startActiveSpan: (...args) => {
      let f;
      for (let i = args.length - 1; i >= 0; i--) {
        if (typeof args[i] === "function") {
          f = args[i];
          break;
        }
      }
      return typeof f === "function" ? f(noopSpan) : noopSpan;
    },
  };
  const noopTracerProvider = {
    getTracer: () => noopTracer,
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
  const noopCtx = { getValue(){ return undefined; }, setValue(){ return this; }, deleteValue(){ return this; } };
  return {
    trace: {
      getTracer: () => noopTracer,
      getTracerProvider: () => noopTracerProvider,
      setGlobalTracerProvider: () => false,
      getSpan: () => undefined,
      getActiveSpan: () => undefined,
      getSpanContext: () => undefined,
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
