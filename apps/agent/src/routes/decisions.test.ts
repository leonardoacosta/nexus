/**
 * GET /decisions passthrough tests (nv two-hop decision transport).
 *
 * Mirrors the fail-soft shape of the `/queue` passthrough (queue.ts): the
 * handler forwards `since` + `action` to the mx gateway and returns the body
 * verbatim, but a down / non-200 gateway degrades to an empty JSON array `[]`
 * with HTTP 200. NOTE: mx /decisions returns a bare ARRAY (not `{ items: [] }`),
 * so the fail-soft empty is `[]`.
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

import { handleGetDecisions } from "./decisions";

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

describe("handleGetDecisions — mx gateway passthrough", () => {
  it("forwards since + action to the gateway /decisions path", async () => {
    const body = JSON.stringify([{ request_id: "r1", title: "t", action: "approve" }]);
    const { urls } = stubFetch(
      () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const res = await handleGetDecisions(
      new Request("http://agent.local/decisions?since=2026-07-01T00:00:00Z&action=approve"),
    );

    expect(urls).toHaveLength(1);
    const upstream = urls[0]!;
    expect(upstream.pathname).toBe("/decisions");
    expect(upstream.searchParams.get("since")).toBe("2026-07-01T00:00:00Z");
    expect(upstream.searchParams.get("action")).toBe("approve");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body); // verbatim passthrough
  });

  it("only forwards since/action when present", async () => {
    const { urls } = stubFetch(
      () => new Response(JSON.stringify([]), { status: 200 }),
    );

    await handleGetDecisions(new Request("http://agent.local/decisions"));

    const upstream = urls[0]!;
    expect(upstream.pathname).toBe("/decisions");
    expect(upstream.searchParams.has("since")).toBe(false);
    expect(upstream.searchParams.has("action")).toBe(false);
  });

  it("fail-soft: gateway unreachable -> 200 empty array []", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    const res = await handleGetDecisions(new Request("http://agent.local/decisions"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("fail-soft: gateway 500 -> 200 empty array []", async () => {
    stubFetch(() => new Response("upstream boom", { status: 500 }));

    const res = await handleGetDecisions(
      new Request("http://agent.local/decisions?action=reject"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});
