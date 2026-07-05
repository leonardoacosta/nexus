/**
 * GET /requests passthrough tests (add-radar-source-panel task 3.1).
 *
 * Mirrors the fail-soft shape of the `/sources` passthrough (sources.ts): the
 * handler forwards `status` / `source` / `changed_since` to the mx gateway and
 * returns the body verbatim, but a down / non-200 gateway degrades to an empty
 * `{ requests: [] }` with HTTP 200 so the Radar drawer shows a named empty
 * state instead of crashing.
 *
 * NOTE ON "502-class": the tasks.md line predates `drop-attach-secret-gate`
 * and the fail-soft decision. The SHIPPED behavior (requests.ts) returns 200 +
 * empty feed on gateway failure — these tests assert that REAL contract, and
 * there is no per-request auth gate to forward.
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

import { handleGetRequests } from "./requests";

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

describe("handleGetRequests — mx gateway passthrough", () => {
  it("forwards status/source/changed_since to the gateway /requests path", async () => {
    const body = JSON.stringify({ requests: [{ id: "1", title: "t" }] });
    const { urls } = stubFetch(
      () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const res = await handleGetRequests(
      new Request(
        "http://agent.local/requests?status=OPEN&source=teams&changed_since=2026-07-01T00%3A00%3A00Z",
      ),
    );

    expect(urls).toHaveLength(1);
    const upstream = urls[0]!;
    expect(upstream.pathname).toBe("/requests");
    expect(upstream.searchParams.get("status")).toBe("OPEN");
    expect(upstream.searchParams.get("source")).toBe("teams");
    expect(upstream.searchParams.get("changed_since")).toBe("2026-07-01T00:00:00Z");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body); // verbatim passthrough
  });

  it("only forwards params that are present", async () => {
    const { urls } = stubFetch(
      () => new Response(JSON.stringify({ requests: [] }), { status: 200 }),
    );

    await handleGetRequests(new Request("http://agent.local/requests?source=ado"));

    const upstream = urls[0]!;
    expect(upstream.searchParams.get("source")).toBe("ado");
    expect(upstream.searchParams.has("status")).toBe(false);
    expect(upstream.searchParams.has("changed_since")).toBe(false);
  });

  it("fail-soft: gateway unreachable -> 200 empty { requests: [] }", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    const res = await handleGetRequests(new Request("http://agent.local/requests"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requests: [] });
  });

  it("fail-soft: gateway 500 -> 200 empty { requests: [] }", async () => {
    stubFetch(() => new Response("upstream boom", { status: 500 }));

    const res = await handleGetRequests(new Request("http://agent.local/requests?status=MINE"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requests: [] });
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});
