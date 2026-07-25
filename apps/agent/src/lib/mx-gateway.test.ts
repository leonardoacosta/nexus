/**
 * mx-gateway passthrough helper tests (plan 029).
 *
 * Covers both postures: gatewayGetFailSoft (param forwarding, non-200
 * fail-soft, fetch-throw fail-soft) and gatewayPostRelay (verbatim relay
 * of 2xx/non-2xx, fetch-throw -> 504).
 */

import { describe, expect, it, mock, afterEach } from "bun:test";
import * as coreNode from "@nexus/core/node";

// ── Stub the logger before importing the SUT ───────────────────────────────
// mock.module is PROCESS-GLOBAL; spread the real barrel so sibling suites keep
// every other @nexus/core/node export (nx-jlx1c).
const loggerMock = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};
mock.module("@nexus/core/node", () => ({
  ...coreNode,
  logger: loggerMock,
}));

import { gatewayGetFailSoft, gatewayPostRelay } from "./mx-gateway";

// ── fetch stubbing ─────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Capture the URL each call receives; respond with the given handler. */
function stubFetch(
  respond: (url: URL) => Response | Promise<Response> | never,
): { urls: URL[] } {
  const urls: URL[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    urls.push(url);
    return respond(url);
  }) as unknown as typeof fetch;
  return { urls };
}

describe("gatewayGetFailSoft", () => {
  it("forwards allowlisted params present on the incoming URL", async () => {
    const body = JSON.stringify({ items: [{ id: "1" }] });
    const { urls } = stubFetch(
      () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const res = await gatewayGetFailSoft({
      path: "/queue",
      route: "/queue",
      emptyPayload: JSON.stringify({ items: [] }),
      incomingUrl: new URL("http://agent.local/queue?limit=25"),
      forwardParams: ["limit"],
    });

    expect(urls).toHaveLength(1);
    const upstream = urls[0]!;
    expect(upstream.pathname).toBe("/queue");
    expect(upstream.searchParams.get("limit")).toBe("25");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });

  it("omits allowlisted params absent from the incoming URL", async () => {
    const { urls } = stubFetch(
      () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );

    await gatewayGetFailSoft({
      path: "/queue",
      route: "/queue",
      emptyPayload: JSON.stringify({ items: [] }),
      incomingUrl: new URL("http://agent.local/queue"),
      forwardParams: ["limit"],
    });

    const upstream = urls[0]!;
    expect(upstream.searchParams.has("limit")).toBe(false);
  });

  it("forwards an empty-string param verbatim (decision 3)", async () => {
    const { urls } = stubFetch(
      () => new Response("[]", { status: 200 }),
    );

    await gatewayGetFailSoft({
      path: "/triage",
      route: "/triage",
      emptyPayload: "[]",
      incomingUrl: new URL("http://agent.local/triage?source="),
      forwardParams: ["source"],
    });

    const upstream = urls[0]!;
    expect(upstream.searchParams.has("source")).toBe(true);
    expect(upstream.searchParams.get("source")).toBe("");
  });

  it("fail-soft: upstream non-200 -> 200 + exact empty payload", async () => {
    stubFetch(() => new Response("upstream boom", { status: 500 }));

    const res = await gatewayGetFailSoft({
      path: "/queue",
      route: "/queue",
      emptyPayload: JSON.stringify({ items: [] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("fail-soft: fetch throw -> 200 + exact empty payload", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    const res = await gatewayGetFailSoft({
      path: "/queue",
      route: "/queue",
      emptyPayload: JSON.stringify({ items: [] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });
});

describe("gatewayPostRelay", () => {
  it("forwards the body verbatim via POST and relays a 200 status + body verbatim", async () => {
    const reqBody = JSON.stringify({ title: "t" });
    let capturedMethod: string | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      capturedMethod = init?.method;
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ id: "abc" }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await gatewayPostRelay({
      path: "/capture",
      route: "/capture",
      body: reqBody,
      unreachableError: "capture gateway unreachable",
    });

    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toBe(reqBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "abc" });
  });

  it("relays a non-2xx status + body verbatim (body not swallowed)", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ error: "conflict" }), { status: 409 }),
    ) as unknown as typeof fetch;

    const res = await gatewayPostRelay({
      path: "/requests/1/decision",
      route: "/requests/:id/decision",
      body: "{}",
      unreachableError: "decision gateway unreachable",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
  });

  it("fetch throw -> 504 with { error: unreachableError }", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const res = await gatewayPostRelay({
      path: "/capture",
      route: "/capture",
      body: "{}",
      unreachableError: "capture gateway unreachable",
    });

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "capture gateway unreachable" });
  });

  it("attaches Authorization: Bearer <token> when MX_GATEWAY_TOKEN is set (mx-izvw.1)", async () => {
    const prevToken = process.env.MX_GATEWAY_TOKEN;
    process.env.MX_GATEWAY_TOKEN = "test-token-123";
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // Re-import the module fresh (cache-busted query string) so it re-reads
    // process.env.MX_GATEWAY_TOKEN — the module caches the token in a
    // top-level const at import time, and the top-of-file import above ran
    // before this test set the env var. Date.now() alone can collide with
    // the sibling test's re-import when both run in the same millisecond
    // (nx-4hzxd/nx-ju35c) — crypto.randomUUID() guarantees a distinct
    // specifier so Bun never returns the other test's cached module.
    const { gatewayPostRelay: freshGatewayPostRelay } = await import(
      `./mx-gateway?t=${crypto.randomUUID()}`
    );

    const res = await freshGatewayPostRelay({
      path: "/capture",
      route: "/capture",
      body: "{}",
      unreachableError: "capture gateway unreachable",
    });

    expect(res.status).toBe(200);
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer test-token-123");

    if (prevToken === undefined) delete process.env.MX_GATEWAY_TOKEN;
    else process.env.MX_GATEWAY_TOKEN = prevToken;
  });

  it("omits Authorization header when MX_GATEWAY_TOKEN is unset (fail-open forward)", async () => {
    const prevToken = process.env.MX_GATEWAY_TOKEN;
    delete process.env.MX_GATEWAY_TOKEN;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const { gatewayPostRelay: freshGatewayPostRelay } = await import(
      `./mx-gateway?t=${crypto.randomUUID()}`
    );

    const res = await freshGatewayPostRelay({
      path: "/capture",
      route: "/capture",
      body: "{}",
      unreachableError: "capture gateway unreachable",
    });

    expect(res.status).toBe(200);
    expect(capturedHeaders?.has("Authorization")).toBe(false);

    if (prevToken === undefined) delete process.env.MX_GATEWAY_TOKEN;
    else process.env.MX_GATEWAY_TOKEN = prevToken;
  });
});
