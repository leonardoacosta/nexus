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

    // The report keyed into the studio machine bucket (macHost present).
    expect(getPresenceContext().vectorFor("studio").macHost.value).toBe("studio");
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

  // ── Phase 1.7: per-machine keying (fleet-aware-rules-eval) ──────────────────

  it("keys a report carrying macHost into that machine's bucket", async () => {
    const res = await handlePresenceReport(
      makeReq({ macActive: true, macHost: "studio" }),
    );
    expect(res.status).toBe(200);

    const ctx = getPresenceContext();
    // The remote machine's vector reflects the report…
    expect(ctx.vectorFor("studio").macActive.value).toBe(true);
    expect(ctx.machines()).toContain("studio");
  });

  it("a macHost-keyed report does not write into the local machine's vector", async () => {
    const res = await handlePresenceReport(
      makeReq({ macActive: true, macHost: "studio" }),
    );
    expect(res.status).toBe(200);

    // The local vector (no macHost) stays unknown — no conflation.
    expect(getPresenceContext().vector().macActive.confidence).toBe("unknown");
  });

  it("a report with no macHost falls back to the local machine", async () => {
    const res = await handlePresenceReport(makeReq({ macActive: true }));
    expect(res.status).toBe(200);
    expect(getPresenceContext().vector().macActive.value).toBe(true);
  });

  // ── Phase 2 (ios-presence-reporter): global phone signals ──────────────────

  it("stores phone signals in the GLOBAL phone record (default either → isBedtime)", async () => {
    // No DB wired → readBedtimeSources defaults to "either"; an active HK
    // window makes isBedtime true on the overlay.
    const res = await handlePresenceReport(
      makeReq({ hkSleepWindow: true, sleepFocusActive: false, phoneFocusOn: true }),
    );
    expect(res.status).toBe(200);

    const ctx = getPresenceContext();
    // The global fields overlay onto any base vector regardless of machine.
    const overlaid = ctx.overlayGlobalPhoneFields(ctx.vector());
    expect(overlaid.isBedtime.value).toBe(true);
    expect(overlaid.isBedtime.confidence).not.toBe("unknown");
    expect(overlaid.phoneFocusOn.value).toBe(true);
  });

  it("echoes the overlaid global phone fields in the response vector", async () => {
    const res = await handlePresenceReport(
      makeReq({ phoneFocusOn: true }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      vector: { phoneFocusOn: { value: boolean | null } };
    };
    expect(body.vector.phoneFocusOn.value).toBe(true);
  });

  it("a phone-only report does NOT write a mac bucket (no macActive)", async () => {
    const res = await handlePresenceReport(makeReq({ phoneFocusOn: true }));
    expect(res.status).toBe(200);
    // The local mac vector stays all-unknown — phone signals are global.
    expect(getPresenceContext().vector().macActive.confidence).toBe("unknown");
  });

  it("rejects a non-boolean hkSleepWindow with 400", async () => {
    const res = await handlePresenceReport(makeReq({ hkSleepWindow: "yes" }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-boolean sleepFocusActive with 400", async () => {
    const res = await handlePresenceReport(makeReq({ sleepFocusActive: 1 }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-boolean phoneFocusOn with 400", async () => {
    const res = await handlePresenceReport(makeReq({ phoneFocusOn: "on" }));
    expect(res.status).toBe(400);
  });

  it("accepts a `machine` identity field on a phone report", async () => {
    const res = await handlePresenceReport(
      makeReq({ machine: "leo-iphone", phoneFocusOn: true }),
    );
    expect(res.status).toBe(200);
  });

  it("a phone report with no machine identity is still handled (global record)", async () => {
    const res = await handlePresenceReport(makeReq({ hkSleepWindow: true }));
    expect(res.status).toBe(200);
    const ctx = getPresenceContext();
    const overlaid = ctx.overlayGlobalPhoneFields(ctx.vector());
    expect(overlaid.isBedtime.value).toBe(true);
  });
});
