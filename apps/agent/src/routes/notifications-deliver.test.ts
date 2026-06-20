/**
 * POST /notifications/deliver route tests
 * (openspec/changes/cross-machine-delivery, Phase 1.6).
 *
 * Covers: valid payload + secret → NotificationFired emitted + 2xx; bad shape
 * → 400; missing secret → 401; wrong secret → 403; and the loop guard — the
 * handler renders locally and NEVER re-routes/re-forwards.
 */

import {
  describe,
  expect,
  it,
  spyOn,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { lifecycleBus } from "../services/lifecycle-bus";
import { installCoreNodeMock } from "../testing/mock-core-node";

// Shared mocks (nx-509z5): the old partial `mock.module("../services/lifecycle-bus")`
// here stubbed the bus to `{ emit }` ONLY — missing onAny/offAny/on/off — and
// since `mock.module` is process-global + irreversible, that incomplete bus
// leaked into sibling suites (handlePatchSpecStatus / spec-watcher call
// `lifecycleBus.onAny`, which became undefined → TypeError) whenever this
// suite's mock won the last-writer race. Fix: spyOn the REAL bus singleton's
// emit (RESTORABLE — restored in afterAll so siblings get the full bus) and use
// the shared spread-real @nexus/core/node mock.
installCoreNodeMock();

const { handleNotificationDeliver } = await import("./notifications-deliver");

let emitMock: ReturnType<typeof spyOn>;

beforeAll(() => {
  emitMock = spyOn(lifecycleBus, "emit").mockImplementation(
    () => undefined as never,
  );
});

afterAll(() => {
  emitMock.mockRestore();
});

const SECRET = "test-secret";
const prevSecret = process.env.NEXUS_ATTACH_SECRET;

function makeReq(body: unknown, secret?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== undefined) headers["x-nexus-secret"] = secret;
  return new Request("http://127.0.0.1:7400/notifications/deliver", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validBody = {
  id: "fwd-1",
  title: "Build done",
  body: "tc green",
  channel: "tts",
  project: "tc",
};

describe("POST /notifications/deliver", () => {
  beforeEach(() => {
    emitMock.mockClear();
    process.env.NEXUS_ATTACH_SECRET = SECRET;
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.NEXUS_ATTACH_SECRET;
    else process.env.NEXUS_ATTACH_SECRET = prevSecret;
  });

  it("emits NotificationFired and returns 2xx for a valid payload + secret", async () => {
    const res = await handleNotificationDeliver(makeReq(validBody, SECRET));
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(emitMock).toHaveBeenCalledTimes(1);
    const [event, payload] = emitMock.mock.calls[0]!;
    expect(event).toBe("NotificationFired");
    expect((payload as { id: string }).id).toBe("fwd-1");
    expect((payload as { title: string }).title).toBe("Build done");
    expect((payload as { channel: string }).channel).toBe("tts");
  });

  it("returns 401 when the secret header is missing", async () => {
    const res = await handleNotificationDeliver(makeReq(validBody));
    expect(res.status).toBe(401);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the secret is wrong", async () => {
    const res = await handleNotificationDeliver(makeReq(validBody, "wrong"));
    expect(res.status).toBe(403);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed (non-JSON) body", async () => {
    const res = await handleNotificationDeliver(makeReq("not json", SECRET));
    expect(res.status).toBe(400);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a bad shape (missing required fields)", async () => {
    const res = await handleNotificationDeliver(makeReq({ id: "x" }, SECRET));
    expect(res.status).toBe(400);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("renders locally exactly once and never re-routes (loop guard)", async () => {
    // A forwarded body may carry forwarded:true — the deliver path ignores it
    // (it never re-forwards regardless) and emits exactly one local event.
    const res = await handleNotificationDeliver(
      makeReq({ ...validBody, forwarded: true }, SECRET),
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    // Exactly one NotificationFired; no second emit (no re-route hop).
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0]![0]).toBe("NotificationFired");
  });
});
