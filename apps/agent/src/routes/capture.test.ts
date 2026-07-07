/**
 * POST /capture passthrough tests (add-capture-proxy task 1.2).
 *
 * Same DELIBERATE write posture as /requests/:id/decision: NOT fail-soft. A
 * swallowed capture is silent data loss, so the handler relays the gateway
 * status + body VERBATIM (2xx / 4xx / 5xx alike) and maps a network failure or
 * abort to 504 — never a fabricated success.
 *
 * Auth rejection is enforced one layer up in `createRequestHandler` (the origin
 * defense-in-depth 403), not in the route handler, so that case is exercised
 * through the full dispatcher below.
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

import { handlePostCapture } from "./capture";

// ── fetch stubbing ─────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Capture the URL + body each call receives; respond with the given handler. */
function stubFetch(
  respond: (url: URL, init?: RequestInit) => Response | Promise<Response> | never,
): { urls: URL[]; bodies: (string | null)[] } {
  const urls: URL[] = [];
  const bodies: (string | null)[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    urls.push(url);
    bodies.push(typeof init?.body === "string" ? init.body : null);
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { urls, bodies };
}

function captureRequest(body: unknown): Request {
  return new Request("http://agent.local/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handlePostCapture — mx gateway passthrough", () => {
  it("passthrough success: forwards the body to /capture and relays the created id verbatim", async () => {
    const upstreamBody = JSON.stringify({ ok: true, id: "cap-42" });
    const { urls, bodies } = stubFetch(
      () => new Response(upstreamBody, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const payload = { title: "call the vet", url: "https://example.com/vet" };
    const res = await handlePostCapture(captureRequest(payload));

    expect(urls).toHaveLength(1);
    expect(urls[0]!.pathname).toBe("/capture");
    expect(bodies[0]).toBe(JSON.stringify(payload)); // verbatim body

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(upstreamBody); // verbatim passthrough (created id)
  });

  it("verbatim 400 from gateway: relays the downstream 400 status + body unmodified", async () => {
    const upstreamBody = JSON.stringify({ error: "title required", code: "BAD_CAPTURE" });
    stubFetch(() => new Response(upstreamBody, { status: 400 }));

    const res = await handlePostCapture(captureRequest({ url: "https://example.com" }));

    expect(res.status).toBe(400); // NOT rewritten
    expect(await res.text()).toBe(upstreamBody); // body NOT swallowed
  });

  it("504 on timeout: maps a fetch abort to 504 (NOT a fabricated 200)", async () => {
    stubFetch(() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    const res = await handlePostCapture(captureRequest({ title: "hung gateway" }));

    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("capture gateway unreachable");
  });

  it("504 on network error: maps ECONNREFUSED to 504 (NOT a fabricated 200)", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    const res = await handlePostCapture(captureRequest({ title: "gateway down" }));

    expect(res.status).toBe(504);
  });
});

// ── Auth rejection through the full dispatcher ──────────────────────────────
// The route carries no per-request gate of its own; the origin defense-in-depth
// 403 in createRequestHandler is the "auth middleware" every dispatch route
// sits behind. A disallowed browser origin must be rejected with 403 BEFORE the
// capture handler (and therefore the mx gateway) is ever reached.
const { createRequestHandler } = await import("../server-request-handler");
const { ServerState } = await import("../server-websocket");
import type { Server as BunServer } from "bun";
import type { WsData } from "../terminal/stream-manager";

const fakeServer = {} as unknown as BunServer<WsData>;

describe("dispatch: POST /capture auth rejection", () => {
  it("rejects a disallowed (non-Tailscale) browser origin with 403 before touching the gateway", async () => {
    // Fail the test loudly if the gateway is ever dialed — auth must short-circuit.
    globalThis.fetch = mock(async () => {
      throw new Error("gateway must NOT be reached on an auth-rejected capture");
    }) as unknown as typeof fetch;

    const handler = createRequestHandler(ServerState.create(), undefined);
    const request = new Request("http://127.0.0.1:7400/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example.com" },
      body: JSON.stringify({ title: "should never land" }),
    });

    const result = await handler(request, fakeServer);
    if (result === undefined) throw new Error("dispatcher returned undefined (WS upgrade path?)");

    expect(result.status).toBe(403);
    const body = (await result.json()) as { error: string };
    expect(body.error).toBe("origin not allowed");
  });
});
