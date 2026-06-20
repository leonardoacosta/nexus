/**
 * POST /presence/report route tests (openspec/changes/context-aware-routing).
 *
 * Covers: valid merge updates the vector, invalid shape → 400, and the vector
 * reflects the report. No DB — the presence context is in-memory.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import * as coreNode from "@nexus/core/node";

const loggerMock = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  fatal: mock(() => {}),
  child: () => loggerMock,
};

mock.module("@nexus/core/node", () => ({
  ...coreNode,
  logger: loggerMock,
  createLogger: () => loggerMock,
}));

import { handlePresenceReport } from "./presence-report";
import { getPresenceContext, __resetPresenceContext } from "../notifications/presence-context";

function makeReq(body: unknown): Request {
  return new Request("http://127.0.0.1:7400/presence/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /presence/report", () => {
  beforeEach(() => {
    __resetPresenceContext();
  });

  it("merges a valid report and returns 200 with the vector", async () => {
    const res = await handlePresenceReport(makeReq({ macActive: true, macHost: "studio" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vector: { macActive: { value: boolean } } };
    expect(body.vector.macActive.value).toBe(true);

    // The singleton vector reflects the report.
    expect(getPresenceContext().vector().macHost.value).toBe("studio");
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await handlePresenceReport(makeReq("not json"));
    expect(res.status).toBe(400);
  });

  it("rejects a non-object body with 400", async () => {
    const res = await handlePresenceReport(makeReq([1, 2, 3]));
    expect(res.status).toBe(400);
  });

  it("rejects an unknown field with 400", async () => {
    const res = await handlePresenceReport(makeReq({ phoneActive: true }));
    expect(res.status).toBe(400);
  });

  it("rejects a wrong-typed field with 400", async () => {
    const res = await handlePresenceReport(makeReq({ macActive: "yes" }));
    expect(res.status).toBe(400);
  });

  it("rejects an empty body with 400 (nothing to merge)", async () => {
    const res = await handlePresenceReport(makeReq({}));
    expect(res.status).toBe(400);
  });

  // ── Phase 1.5 sensor fields ───────────────────────────────────────────────

  it("merges macIdleSec / macFocus from the headless sensor", async () => {
    const res = await handlePresenceReport(
      makeReq({ macIdleSec: 120, macFocus: "work" }),
    );
    expect(res.status).toBe(200);
    const v = getPresenceContext().vector();
    expect(v.macIdleSec.value).toBe(120);
    expect(v.macFocus.value).toBe("work");
  });

  it("accepts an explicit null macFocus (no active Focus)", async () => {
    const res = await handlePresenceReport(makeReq({ macFocus: null }));
    expect(res.status).toBe(200);
  });

  it("rejects a negative macIdleSec with 400", async () => {
    const res = await handlePresenceReport(makeReq({ macIdleSec: -5 }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-number macIdleSec with 400", async () => {
    const res = await handlePresenceReport(makeReq({ macIdleSec: "120" }));
    expect(res.status).toBe(400);
  });

  it("merges phonePresent / phoneHome when reported directly", async () => {
    const res = await handlePresenceReport(
      makeReq({ phonePresent: true, phoneHome: true }),
    );
    expect(res.status).toBe(200);
    const v = getPresenceContext().vector();
    expect(v.phonePresent.value).toBe(true);
    expect(v.phoneHome.value).toBe(true);
  });

  it("maps the gateway-MAC homeHint onto phoneHome", async () => {
    const res = await handlePresenceReport(makeReq({ homeHint: true }));
    expect(res.status).toBe(200);
    expect(getPresenceContext().vector().phoneHome.value).toBe(true);
  });

  it("an explicit phoneHome wins over a conflicting homeHint", async () => {
    const res = await handlePresenceReport(
      makeReq({ phoneHome: false, homeHint: true }),
    );
    expect(res.status).toBe(200);
    expect(getPresenceContext().vector().phoneHome.value).toBe(false);
  });

  it("rejects a non-boolean homeHint with 400", async () => {
    const res = await handlePresenceReport(makeReq({ homeHint: "yes" }));
    expect(res.status).toBe(400);
  });
});
