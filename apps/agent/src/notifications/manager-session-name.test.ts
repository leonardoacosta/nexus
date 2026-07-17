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

import {
  describe,
  expect,
  it,
  spyOn,
  beforeAll,
  afterAll,
  afterEach,
} from "bun:test";

import { lifecycleBus } from "../services/lifecycle-bus";
import type {
  NotificationFiredPayload,
  LifecycleEnvelope,
} from "../services/lifecycle-bus";
import { installNexusDbMock } from "../testing/mock-nexus-db";
import { installCoreNodeMock } from "../testing/mock-core-node";
import { installBufferMock, type BufferMockHandle } from "./testing-mocks";
import * as routerNs from "./router";

// Shared mocks (nx-509z5). The old partial `mock.module("./buffer")` /
// `mock.module("./router")` here claimed to be "mock-isolated in its own file"
// — but `mock.module` is process-global + irreversible, so the partial ./buffer
// stub (missing getNotificationById) and the all-replacing ./router stub leaked
// into router.test.ts / reliability-regression.test.ts / manager-presence.test.ts
// in the full alphabetical run. ./buffer + ./router are now SPIED in beforeAll /
// restored in afterAll (only active for THIS suite). The bus stays REAL — this
// suite subscribes to NotificationFired via .on().
installNexusDbMock();
installCoreNodeMock();

let NotificationManager: typeof import("./manager").NotificationManager;
let bufferMock: BufferMockHandle;
let routeParallelSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  bufferMock = installBufferMock();
  // Single "desktop" channel delivered (no TTS audio bytes — keeps the
  // audio-column UPDATE branch out of scope). Only routeNotificationParallel
  // is spied; every other router export stays real for sibling suites.
  routeParallelSpy = spyOn(
    routerNs,
    "routeNotificationParallel",
  ).mockImplementation(async () => ({
    delivered: [{ channel: "desktop" }],
    failed: [],
  }));
  ({ NotificationManager } = await import("./manager"));
});

afterAll(() => {
  routeParallelSpy.mockRestore();
  bufferMock.restore();
});

/** A minimal db stub — the manager only touches `db.update(...)` on the TTS
 * audio branch, which our desktop-only router result never hits. */
const fakeDb = {} as never;

// drop-permission-request-tts-draft (nx-wuit5, 2026-07-16): the fixture used
// to mirror `permissionRequestRule`'s desktop draft, but that rule was
// removed from the registry — the sessionName-threading coverage below is
// about `NotificationManager.send()`'s extras plumbing, not any specific
// rule's output shape, so the fixture now mirrors `hookFailureRule`'s
// surviving desktop-only draft instead.
function baseRow() {
  return {
    id: `nx-20caf-${Math.random().toString(36).slice(2)}`,
    channel: "desktop" as const,
    title: "hook failed: post_compact",
    body: "nx: hook post_compact failed",
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
    expect(cap.events[0]!.body).toBe("nx: hook post_compact failed");
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
