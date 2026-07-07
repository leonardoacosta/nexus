/**
 * GET /queue passthrough tests (add-decide-flow-menubar task 1.3).
 *
 * Mirrors the fail-soft shape of the `/requests` passthrough (requests.ts):
 * the handler forwards `limit` to the mx gateway and returns the body
 * verbatim, but a down / non-200 gateway degrades to an empty `{ items: [] }`
 * with HTTP 200 so the Decide-flow menubar shows a named empty state instead
 * of crashing.
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

import { handleGetQueue } from "./queue";

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

describe("handleGetQueue — mx gateway passthrough", () => {
  it("forwards limit to the gateway /queue path", async () => {
    const body = JSON.stringify({ items: [{ id: "1", title: "t" }] });
    const { urls } = stubFetch(
      () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const res = await handleGetQueue(
      new Request("http://agent.local/queue?limit=25"),
    );

    expect(urls).toHaveLength(1);
    const upstream = urls[0]!;
    expect(upstream.pathname).toBe("/queue");
    expect(upstream.searchParams.get("limit")).toBe("25");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body); // verbatim passthrough
  });

  it("only forwards limit when present", async () => {
    const { urls } = stubFetch(
      () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );

    await handleGetQueue(new Request("http://agent.local/queue"));

    const upstream = urls[0]!;
    expect(upstream.pathname).toBe("/queue");
    expect(upstream.searchParams.has("limit")).toBe(false);
  });

  it("fail-soft: gateway unreachable -> 200 empty { items: [] }", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    const res = await handleGetQueue(new Request("http://agent.local/queue"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it("fail-soft: gateway 500 -> 200 empty { items: [] }", async () => {
    stubFetch(() => new Response("upstream boom", { status: 500 }));

    const res = await handleGetQueue(new Request("http://agent.local/queue?limit=10"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});
