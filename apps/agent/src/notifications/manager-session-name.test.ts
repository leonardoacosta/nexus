/**
 * nx-20caf — end-to-end wire-contract test for the CC custom session name.
 *
 * Asserts that `NotificationManager.send(row, { sessionName })` surfaces
 * `sessionName` on the `NotificationFired` lifecycle envelope (the camelCase
 * wire field the Swift consumer + statusline decode), and that omitting the
 * extra yields `sessionName === undefined` (graceful degrade to today's
 * session-less behavior).
 *
 * The DB (`./buffer`) and the channel router (`./router`) are mocked so the
 * test exercises only the manager's emit path with no Postgres dependency.
 * It is mock-isolated in its own file so the `mock.module` calls don't bleed
 * into the shared `notifications.test.ts` suite.
 */

import { describe, expect, it, mock, beforeAll, afterEach } from "bun:test";

import { lifecycleBus } from "../services/lifecycle-bus";
import type {
  NotificationFiredPayload,
  LifecycleEnvelope,
} from "../services/lifecycle-bus";

// Mock the buffer so no DB is touched.
mock.module("./buffer", () => ({
  insertNotification: async () => {},
  markNotificationDelivered: async () => {},
  markNotificationExpired: async () => {},
  queryNotificationsByStatus: async () => [],
}));

// Mock the router so a single "desktop" channel reports delivered (no TTS
// audio bytes — keeps the audio-column UPDATE branch out of scope).
mock.module("./router", () => ({
  routeNotificationParallel: async () => ({
    delivered: [{ channel: "desktop" }],
    failed: [],
  }),
  routeNotification: async () => [],
  findMatchingRule: () => ({ meeting_behavior: "allow", channels: ["desktop"] }),
  // context-aware-routing: null = presence routing off, use the legacy path.
  decidePresenceRoute: () => null,
  actionToChannels: () => [],
}));

let NotificationManager: typeof import("./manager").NotificationManager;

beforeAll(async () => {
  ({ NotificationManager } = await import("./manager"));
});

/** A minimal db stub — the manager only touches `db.update(...)` on the TTS
 * audio branch, which our desktop-only router result never hits. */
const fakeDb = {} as never;

function baseRow() {
  return {
    id: `nx-20caf-${Math.random().toString(36).slice(2)}`,
    channel: "desktop" as const,
    title: "permission requested: Bash",
    body: "nx: permission requested for Bash",
    project: "nx",
    agentId: null,
    priority: "normal" as const,
    createdAt: new Date(),
  };
}

function captureFired(): { events: NotificationFiredPayload[]; off: () => void } {
  // `on` delivers the LifecycleEnvelope; the actual NotificationFired fields
  // live under `.payload`. Unwrap so assertions read the wire fields directly.
  const events: NotificationFiredPayload[] = [];
  const handler = (env: LifecycleEnvelope<"NotificationFired">) =>
    events.push(env.payload);
  lifecycleBus.on("NotificationFired", handler);
  return { events, off: () => lifecycleBus.off("NotificationFired", handler) };
}

describe("NotificationManager — custom session name on NotificationFired (nx-20caf)", () => {
  let cap: ReturnType<typeof captureFired>;

  afterEach(() => cap?.off());

  it("emits sessionName when threaded via extras", async () => {
    cap = captureFired();
    const mgr = new NotificationManager(fakeDb);

    await mgr.send(baseRow(), { sessionName: "backend wave" });

    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.sessionName).toBe("backend wave");
    // body untouched — the spoken/visible text degrades to today's behavior.
    expect(cap.events[0]!.body).toBe("nx: permission requested for Bash");
  });

  it("emits sessionName === undefined when no extras are supplied", async () => {
    cap = captureFired();
    const mgr = new NotificationManager(fakeDb);

    await mgr.send(baseRow());

    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.sessionName).toBeUndefined();
  });

  it("emits sessionName === undefined when extras omit it", async () => {
    cap = captureFired();
    const mgr = new NotificationManager(fakeDb);

    await mgr.send(baseRow(), { logPath: "/tmp/x.log" });

    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.sessionName).toBeUndefined();
    // sibling transport extras still flow through.
    expect(cap.events[0]!.logPath).toBe("/tmp/x.log");
  });
});
