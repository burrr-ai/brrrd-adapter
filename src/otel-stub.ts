// TD-11: OpenTelemetry API stub. Next.js tracer requires `@opentelemetry/api` but
// 운영 환경에선 brrrd 자체 OTel 파이프라인 (B-2) 으로 대체될 예정. 사용자가 별도
// otel SDK 를 의존성으로 추가하지 않은 경우의 no-op 폴백.
//
// 분리 이유: bundler.ts 의 REQUIRE_BANNER 가 비대해지지 않게 하고 향후 stub
// 동작 (예: noop tracer → 실제 otel global) 교체가 쉬워지도록 모듈로 격리.

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
