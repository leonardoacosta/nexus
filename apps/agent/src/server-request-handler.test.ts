/**
 * Dispatch-level test for the OTel span wrapper around `handleRequest`
 * (wire-nexus-agent-grafana-otel task 2.3).
 *
 * `createRequestHandler`'s returned `handleRequest` wraps the entire
 * ~106-route if-chain (`handleRequestInner`) in a single
 * `getTracer().startActiveSpan("http.request", ...)` span tagged with
 * `http.method` / `http.route` / `http.status_code`, so every route gets
 * trace coverage from one chokepoint instead of per-handler instrumentation.
 *
 * This does NOT use the process-global provider registered by `./otel`
 * (`provider.register()` there mutates `@opentelemetry/api`'s global
 * singleton, and `@opentelemetry/api` only allows ONE registration per
 * process — a second `.register()` call from this test would silently no-op,
 * per the repo's own documented Bun process-global mutation hazard,
 * `reference_bun_mock_module_contamination`). Instead, `./otel` is
 * `mock.module`'d so `getTracer()` returns a tracer bound to a
 * `NodeTracerProvider` instantiated locally in this file with a
 * `SimpleSpanProcessor` wrapping an `InMemorySpanExporter` — spans are
 * captured directly off that provider, never through the global registry.
 *
 * Run:
 *   cd apps/agent && bun test src/server-request-handler.test.ts
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";

// ─── Isolated tracer (mock.module BEFORE importing the SUT) ────────────────
//
// A local provider, never `.register()`'d against the global @opentelemetry/api
// singleton — `provider.getTracer(name)` returns a tracer bound directly to
// this provider's processors, independent of whatever (if anything) other
// test files in the same bun test process have registered globally.
const memoryExporter = new InMemorySpanExporter();
const testProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
});
const testTracer = testProvider.getTracer("test");

mock.module("./otel", () => ({
  getTracer: () => testTracer,
}));

import type { Server as BunServer } from "bun";
// Dynamic imports (after the mock.module above) so the SUT resolves
// `getTracer` from the stubbed module rather than the real, side-effecting
// `./otel` (which would otherwise register a real global provider).
const { createRequestHandler } = await import("./server-request-handler");
const { ServerState } = await import("./server-websocket");
import type { WsData } from "./terminal/stream-manager";

const fakeServer = {} as unknown as BunServer<WsData>;

function makeRequest(method: string, path: string): Request {
  return new Request(`http://127.0.0.1:7400${path}`, { method });
}

beforeEach(() => {
  memoryExporter.reset();
});

describe("createRequestHandler: http.request span", () => {
  it("tags an async-resolved route (GET /version) with method/route/status", async () => {
    const handler = createRequestHandler(ServerState.create(), undefined);
    const res = await handler(makeRequest("GET", "/version"), fakeServer);
    expect(res).toBeDefined();
    expect(res!.status).toBe(200);

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("http.request");
    expect(spans[0]!.attributes["http.method"]).toBe("GET");
    expect(spans[0]!.attributes["http.route"]).toBe("/version");
    expect(spans[0]!.attributes["http.status_code"]).toBe(200);
    expect(spans[0]!.status.code).not.toBe(2); // not ERROR
  });

  it("tags a sync-resolved route (unmatched path -> 404) with the real status", async () => {
    const handler = createRequestHandler(ServerState.create(), undefined);
    const result = handler(makeRequest("GET", "/does-not-exist"), fakeServer);
    // The 404 catch-all is a plain synchronous `Response`, not a Promise —
    // locks in that the span wrapper handles both return shapes.
    expect(result).not.toBeInstanceOf(Promise);
    const res = result as Response;
    expect(res.status).toBe(404);

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes["http.method"]).toBe("GET");
    expect(spans[0]!.attributes["http.route"]).toBe("/does-not-exist");
    expect(spans[0]!.attributes["http.status_code"]).toBe(404);
  });
});
