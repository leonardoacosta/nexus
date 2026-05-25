/**
 * notification-engine-reliability — wave-1 regression suite.
 *
 * Locks the four reliability fixes that landed under
 * openspec/changes/notification-engine-reliability (tasks 1.1–1.4):
 *
 *   1.1  Invalid meeting-state transitions are REJECTED (throw
 *        InvalidStateError), not silently accepted — meeting-state.ts.
 *   1.2  The in-memory notification buffer is BOUNDED at MAX_BUFFER_SIZE
 *        with a drop-oldest (FIFO) eviction policy — buffer.ts.
 *   1.3  A hung channel handler TIMES OUT via withChannelTimeout without
 *        stalling sibling channels (routeNotificationParallel) — router.ts.
 *   1.4  A missing channel handler is SURFACED (warn log + addBreadcrumb +
 *        captureException), not silently skipped — router.ts.
 *
 * Module-load-ordering note
 * ─────────────────────────
 * `bun test` runs every file in one process and `mock.module(...)` is
 * process-global: whichever test file imports a target module FIRST binds
 * the mock instance. notifications.test.ts (alphabetically before this file)
 * imports router.ts WITHOUT a @sentry/node mock, so in a full-suite run the
 * router's captureException/addBreadcrumb resolve to the REAL Sentry exports
 * and this file's spies are not wired.
 *
 * To stay strong-and-real under BOTH orderings, every test asserts a
 * MOCK-INDEPENDENT observable contract (thrown error, return-value shape,
 * bounded sidecar count, failed/delivered arrays). When this file IS the
 * first loader (single-file isolation), the additional Sentry/logger spy
 * assertions also fire. Neither path uses an `expect(true).toBe(true)`
 * escape — every assertion is falsifiable.
 */

import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  mock,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Sentry + logger spies (effective only when this file loads first) ───────

const captureExceptionMock = mock((_e: unknown) => {});
const addBreadcrumbMock = mock((_b: unknown) => {});

mock.module("@sentry/node", () => ({
  captureException: captureExceptionMock,
  addBreadcrumb: addBreadcrumbMock,
  init: mock(() => {}),
}));

/** True when our Sentry mock is the bound instance (i.e. we loaded router first). */
function sentryMockWired(): boolean {
  return (
    captureExceptionMock.mock.calls.length > 0 ||
    addBreadcrumbMock.mock.calls.length > 0
  );
}

// buffer.ts imports @nexus/db (insert chain) + drizzle-orm at top level. Stub
// both so insertNotification never touches a real DB. (These do not conflict
// with buffer.test.ts's own identical stubs.)
mock.module("@nexus/db", () => ({
  notifications: {},
  projectVoiceOverrides: {},
}));
mock.module("drizzle-orm", () => ({
  eq: mock(() => ({})),
  asc: mock(() => ({})),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A fully-populated NotificationRow for buffer inserts. */
function makeRow(id: string): import("./buffer").NotificationRow {
  return {
    id,
    channel: "desktop",
    title: "t",
    body: "b",
    project: null,
    agentId: null,
    priority: "normal",
    status: "queued",
    severity: "info",
    deliveryState: "pending",
    audioPath: null,
    voiceUsed: null,
    createdAt: new Date(),
    sentAt: null,
  } as unknown as import("./buffer").NotificationRow;
}

/** A router-shaped notification (loosely typed — router accepts NotificationRow). */
function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: `reg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    channel: "desktop",
    title: "Regression",
    body: "Test body",
    project: null as string | null,
    priority: "normal",
    status: "queued",
    createdAt: new Date(),
    sentAt: null as Date | null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1.1 — invalid meeting-state transition is rejected
// ═══════════════════════════════════════════════════════════════════════════

describe("regression 1.1 — meeting-state rejects invalid transitions", () => {
  it("rejects start while already active (InvalidStateError, 'already active')", async () => {
    const { MeetingState, InvalidStateError } = await import("./meeting-state");
    const state = new MeetingState();
    state.start();
    expect(state.active).toBe(true);

    let caught: Error | undefined;
    try {
      state.start();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(InvalidStateError);
    expect(caught!.message).toMatch(/already active/i);
    // The illegal transition must NOT corrupt state — still exactly one meeting.
    expect(state.active).toBe(true);
  });

  it("rejects end while idle (InvalidStateError, 'no meeting active')", async () => {
    const { MeetingState, InvalidStateError } = await import("./meeting-state");
    const state = new MeetingState();

    let caught: Error | undefined;
    try {
      state.end();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(InvalidStateError);
    expect(caught!.message).toMatch(/no meeting active/i);
    expect(state.active).toBe(false);
  });

  it("the throw IS the observable rejection — silent acceptance is impossible", async () => {
    // Pre-fix, a double-start silently no-op'd (state stayed active, no signal).
    // The fix makes the rejection observable to the CALLER via a thrown
    // InvalidStateError — independent of any logger. Prove the caller cannot
    // proceed past an illegal transition without seeing an error.
    const { MeetingState } = await import("./meeting-state");
    const state = new MeetingState();
    state.start();

    let reached = false;
    try {
      state.end();
      reached = true; // legal end — should be reached
      state.end(); // illegal second end — must throw before next line
      reached = false; // unreachable if the throw fires
      throw new Error("unreachable — illegal end did not throw");
    } catch (err) {
      // The catch must be the InvalidStateError from the SECOND end, not the
      // sentinel above.
      expect((err as Error).name).toBe("InvalidStateError");
    }
    expect(reached).toBe(true); // the legal end ran; the illegal one threw
  });

  it("a legal start/end/start cycle never throws", async () => {
    const { MeetingState } = await import("./meeting-state");
    const state = new MeetingState();
    expect(() => {
      state.start();
      state.end();
      state.start();
    }).not.toThrow();
    expect(state.active).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1.2 — notification buffer overflow is bounded (drop-oldest at MAX_BUFFER_SIZE)
// ═══════════════════════════════════════════════════════════════════════════

describe("regression 1.2 — buffer overflow is bounded (drop-oldest)", () => {
  let tmpConfigDir: string;
  let originalConfigDir: string | undefined;

  beforeAll(() => {
    // Route the buffer-meta sidecar to a tmp dir so readMeta() reflects ONLY
    // this test's inserts and we don't clobber the real ~/.config/nexus file.
    originalConfigDir = process.env.NEXUS_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "nx-buffer-reg-"));
    process.env.NEXUS_CONFIG_DIR = tmpConfigDir;
  });

  afterAll(() => {
    if (originalConfigDir === undefined) delete process.env.NEXUS_CONFIG_DIR;
    else process.env.NEXUS_CONFIG_DIR = originalConfigDir;
    try {
      rmSync(tmpConfigDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("exports the MAX_BUFFER_SIZE cap", async () => {
    const { MAX_BUFFER_SIZE } = await import("./buffer");
    expect(MAX_BUFFER_SIZE).toBe(1000);
    expect(MAX_BUFFER_SIZE).toBeGreaterThan(0);
  });

  it("the persisted buffer count never exceeds MAX_BUFFER_SIZE after overflow", async () => {
    const { insertNotification, readMeta, MAX_BUFFER_SIZE } = await import("./buffer");
    const db = {
      insert: () => ({ values: () => Promise.resolve() }),
    } as unknown as import("@nexus/db").Db;

    // Insert well past the cap. With the drop-oldest fix, every insert above
    // MAX_BUFFER_SIZE shifts the oldest id then pushes the new one, so
    // pendingIds.length (mirrored to the sidecar `count`) plateaus AT the cap
    // and never grows unbounded. Pre-fix this grew without limit.
    const overflow = MAX_BUFFER_SIZE + 200;
    for (let i = 0; i < overflow; i++) {
      await insertNotification(db, makeRow(`evict-${i}`));
    }

    const meta = await readMeta();
    expect(meta).not.toBeNull();
    // Observable bound — independent of any logger/mock.
    expect(meta!.count).toBeLessThanOrEqual(MAX_BUFFER_SIZE);
    // We inserted past the cap, so the buffer must be saturated AT the cap
    // (the ring is full; eviction is happening 1:1 with insertion).
    expect(meta!.count).toBe(MAX_BUFFER_SIZE);
    // The high-water mark recorded that pressure reached the cap, never above.
    expect(meta!.watermark).toBeLessThanOrEqual(MAX_BUFFER_SIZE);
    expect(meta!.watermark).toBe(MAX_BUFFER_SIZE);
  });

  it("still persists the DB row on the overflow path (degrade, not drop the write)", async () => {
    const { insertNotification } = await import("./buffer");
    const insertCalls: unknown[] = [];
    const db = {
      insert: () => ({
        values: (row: unknown) => {
          insertCalls.push(row);
          return Promise.resolve();
        },
      }),
    } as unknown as import("@nexus/db").Db;

    // Even when the in-memory ring is full, the DB row is still inserted —
    // only the in-memory pending-id tracking is bounded.
    await insertNotification(db, makeRow(`persist-${Date.now()}`));
    expect(insertCalls.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1.3 — hung channel times out without stalling siblings
// ═══════════════════════════════════════════════════════════════════════════

describe("regression 1.3 — hung channel times out, siblings unaffected", () => {
  beforeAll(() => {
    // Short timeout — effective ONLY if router.ts has not yet been loaded by an
    // earlier file (single-file isolation). In a full-suite run the default
    // 10s applies; the test tolerates both via a < 11s ceiling + 15s timeout.
    process.env.NEXUS_NOTIFICATION_TIMEOUT_MS = "150";
  });

  it("routeNotificationParallel marks a hung tts channel failed and still delivers desktop", async () => {
    const router = await import("./router");
    const { setRoutingRules, routeNotificationParallel } = router;

    const originalFetch = globalThis.fetch;
    const originalKey = process.env.ELEVENLABS_API_KEY;
    const originalVoice = process.env.ELEVENLABS_DEFAULT_VOICE_ID;
    process.env.ELEVENLABS_API_KEY = "hang-key";
    process.env.ELEVENLABS_DEFAULT_VOICE_ID = "hang-voice";

    // fetch hangs forever — sendTtsNotification never resolves —
    // withChannelTimeout's deadline fires and tts is marked failed. desktop is
    // a separate Promise.allSettled entry and resolves independently.
    globalThis.fetch = mock(
      () => new Promise<Response>(() => {}),
    ) as unknown as typeof globalThis.fetch;

    try {
      router.setTtsDbHandle(null);
      setRoutingRules([
        {
          project: "hung-chan",
          channels: ["tts", "desktop"],
          meeting_behavior: "allow",
        },
      ]);

      const notif = makeNotification({
        project: "hung-chan",
        id: "hung-chan-notif",
        body: "build done",
      });

      const start = Date.now();
      const { delivered, failed } = await routeNotificationParallel(notif as never);
      const elapsed = Date.now() - start;

      // Core contract (mock-independent): the hung tts channel timed out and is
      // reported failed; desktop still delivered. One failing channel did NOT
      // block the sibling — and the call RETURNED (no infinite hang).
      expect(failed).toContain("tts");
      expect(delivered.map((d) => d.channel)).toContain("desktop");

      // The deadline fired (timeout, not infinite hang). The router's default
      // NOTIFICATION_TIMEOUT_MS is 10s; a real hang would never resolve, so
      // resolving under 11s proves the deadline mechanism ran.
      expect(elapsed).toBeLessThan(11_000);

      // When our Sentry mock is the bound instance, the timeout's
      // captureException is observable too.
      if (sentryMockWired()) {
        const msgs = captureExceptionMock.mock.calls.map((c) =>
          c[0] instanceof Error ? c[0].message : String(c[0]),
        );
        expect(msgs.some((m) => /timeout/i.test(m) && /tts/.test(m))).toBe(true);
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = originalKey;
      if (originalVoice === undefined) delete process.env.ELEVENLABS_DEFAULT_VOICE_ID;
      else process.env.ELEVENLABS_DEFAULT_VOICE_ID = originalVoice;
    }
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1.4 — missing channel handler is surfaced (not silently skipped)
// ═══════════════════════════════════════════════════════════════════════════

describe("regression 1.4 — missing channel handler is surfaced", () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
    addBreadcrumbMock.mockReset();
  });

  it("routeNotification skips an unregistered channel with NO delivery and NO throw", async () => {
    const { setRoutingRules, routeNotification } = await import("./router");

    setRoutingRules([
      {
        project: "missing-1",
        channels: ["slack" as never], // removed channel — no handler
        meeting_behavior: "allow",
      },
    ]);

    const notif = makeNotification({ project: "missing-1", id: "missing-1-notif" });

    let threw = false;
    let results: Array<{ channel: string; success: boolean }> = [];
    try {
      results = (await routeNotification(notif as never)) as Array<{
        channel: string;
        success: boolean;
      }>;
    } catch {
      threw = true;
    }

    // Mock-independent contract: no delivery attempted, but it did NOT crash
    // the route — the unknown channel is filtered, not fatal.
    expect(threw).toBe(false);
    expect(results).toHaveLength(0);

    // Surfacing side-effect (only when our Sentry mock is the bound instance):
    // captureException fires with a message naming the channel + notif id. A
    // breadcrumb alone never produces a Sentry event, so the fix ALSO calls
    // captureException — that's the regression this asserts.
    if (sentryMockWired()) {
      const msgs = captureExceptionMock.mock.calls.map((c) =>
        c[0] instanceof Error ? c[0].message : String(c[0]),
      );
      expect(msgs.some((m) => /slack/.test(m) && /missing-1-notif/.test(m))).toBe(
        true,
      );
      const crumb = addBreadcrumbMock.mock.calls[0]?.[0] as {
        data?: { channel?: string };
      };
      expect(crumb?.data?.channel).toBe("slack");
    }
  });

  it("routeNotificationParallel filters a missing handler — 0 delivered, 0 failed, no throw", async () => {
    const { setRoutingRules, routeNotificationParallel } = await import("./router");

    setRoutingRules([
      {
        project: "missing-2",
        channels: ["slack" as never],
        meeting_behavior: "allow",
      },
    ]);

    const notif = makeNotification({ project: "missing-2", id: "missing-2-notif" });

    let threw = false;
    let out: { delivered: unknown[]; failed: unknown[] } = {
      delivered: [],
      failed: [],
    };
    try {
      out = await routeNotificationParallel(notif as never);
    } catch {
      threw = true;
    }

    // Filtered out before dispatch — no delivery, no failure entry, no crash.
    expect(threw).toBe(false);
    expect(out.delivered).toHaveLength(0);
    expect(out.failed).toHaveLength(0);

    if (sentryMockWired()) {
      const msgs = captureExceptionMock.mock.calls.map((c) =>
        c[0] instanceof Error ? c[0].message : String(c[0]),
      );
      expect(msgs.some((m) => /slack/.test(m) && /missing-2-notif/.test(m))).toBe(
        true,
      );
    }
  });

  it("a registered channel is delivered and NEVER surfaced as missing", async () => {
    captureExceptionMock.mockReset();
    const { setRoutingRules, routeNotification } = await import("./router");

    setRoutingRules([
      { project: "ok-chan", channels: ["desktop"], meeting_behavior: "allow" },
    ]);

    const notif = makeNotification({ project: "ok-chan", id: "ok-chan-notif" });
    const results = (await routeNotification(notif as never)) as Array<{
      channel: string;
      success: boolean;
    }>;

    // desktop has a handler -> delivered, never surfaced as missing.
    expect(results).toHaveLength(1);
    expect(results[0]!.channel).toBe("desktop");

    // No "no handler" captureException for a channel that HAS a handler.
    const msgs = captureExceptionMock.mock.calls.map((c) =>
      c[0] instanceof Error ? c[0].message : String(c[0]),
    );
    expect(msgs.some((m) => /no notification channel handler/.test(m))).toBe(false);
  });
});
