/**
 * POST /requests/{id}/decision passthrough tests (add-decide-flow-menubar
 * task 1.3).
 *
 * The DELIBERATE asymmetry vs /queue + /requests: this route is NOT fail-soft.
 * A swallowed decision is silent pilot-data loss, so the handler relays the
 * gateway status + body VERBATIM (2xx / 409 / 5xx alike) and maps a network
 * failure or abort to 504 — never an empty 200.
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

import { handlePostDecision } from "./decision";

// ── fetch stubbing ─────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Capture the URL + init each call receives; respond with the given handler. */
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

function decisionRequest(id: string, body: unknown): Request {
  return new Request(`http://agent.local/requests/${id}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handlePostDecision — mx gateway passthrough", () => {
  it("forwards the POST body + id in the upstream URL", async () => {
    const upstreamBody = JSON.stringify({ ok: true, id: "req-42" });
    const { urls, bodies } = stubFetch(
      () => new Response(upstreamBody, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const payload = { verdict: "approve", note: "lgtm" };
    const res = await handlePostDecision(decisionRequest("req-42", payload));

    expect(urls).toHaveLength(1);
    const upstream = urls[0]!;
    expect(upstream.pathname).toBe("/requests/req-42/decision");
    expect(bodies[0]).toBe(JSON.stringify(payload)); // verbatim body

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(upstreamBody); // verbatim passthrough
  });

  it("200 passthrough: relays gateway 2xx status + body verbatim", async () => {
    const upstreamBody = JSON.stringify({ accepted: true });
    stubFetch(() => new Response(upstreamBody, { status: 202 }));

    const res = await handlePostDecision(decisionRequest("abc", { verdict: "reject" }));

    expect(res.status).toBe(202);
    expect(await res.text()).toBe(upstreamBody);
  });

  it("propagates a 409 (no live verdict / already decided) VERBATIM", async () => {
    const upstreamBody = JSON.stringify({ error: "no live verdict", code: "ALREADY_DECIDED" });
    stubFetch(() => new Response(upstreamBody, { status: 409 }));

    const res = await handlePostDecision(decisionRequest("stale", { verdict: "approve" }));

    expect(res.status).toBe(409);
    expect(await res.text()).toBe(upstreamBody); // body NOT swallowed
  });

  it("propagates a 5xx gateway error VERBATIM", async () => {
    const upstreamBody = JSON.stringify({ error: "internal gateway boom" });
    stubFetch(() => new Response(upstreamBody, { status: 503 }));

    const res = await handlePostDecision(decisionRequest("boom", { verdict: "approve" }));

    expect(res.status).toBe(503);
    expect(await res.text()).toBe(upstreamBody);
  });

  it("maps a network error to 504 (NOT an empty 200)", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    const res = await handlePostDecision(decisionRequest("req-1", { verdict: "approve" }));

    expect(res.status).toBe(504);
  });

  it("maps a fetch abort to 504 (NOT an empty 200)", async () => {
    stubFetch(() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    const res = await handlePostDecision(decisionRequest("req-1", { verdict: "approve" }));

    expect(res.status).toBe(504);
  });
});
