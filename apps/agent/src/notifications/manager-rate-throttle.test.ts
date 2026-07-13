/**
 * Manager rate-throttle tests (noise-reduction audit 2026-07-13, plan 041).
 *
 * Covers: throttle disabled → no downgrade; under threshold → no downgrade;
 * at/over threshold → tts downgraded to desktop; priority:"high" is never
 * downgraded regardless of count; project-less notifications are never
 * throttled.
 */

import { describe, expect, it, mock, beforeAll, afterAll } from "bun:test";
import { installNexusDbMock } from "../testing/mock-nexus-db";
import { installCoreNodeMock } from "../testing/mock-core-node";
import { installBufferMock, type BufferMockHandle } from "./testing-mocks";

installNexusDbMock();
installCoreNodeMock();

let bufferMock: BufferMockHandle;
beforeAll(() => {
  bufferMock = installBufferMock();
});
afterAll(() => {
  bufferMock.restore();
});

mock.module("@sentry/node", () => ({
  captureException: mock(() => {}),
  addBreadcrumb: mock(() => {}),
  init: mock(() => {}),
}));

const { NotificationManager } = await import("./manager");

const stubDb = {} as never;

function makeRateThrottleStub(opts: {
  enabled: boolean;
  maxPerWindow: number;
  windowMinutes: number;
  recentCount: number;
}) {
  const countRecent = mock(async () => opts.recentCount);
  return {
    settings: mock(async () => ({
      enabled: opts.enabled,
      maxPerWindow: opts.maxPerWindow,
      windowMinutes: opts.windowMinutes,
    })),
    countRecent,
  };
}

function makeSendInput(id: string, overrides: Partial<{ priority: string; project: string | null }> = {}) {
  return {
    id,
    title: "progress ping",
    body: "17 of 19 done",
    channel: "tts",
    priority: overrides.priority ?? "normal",
    project: overrides.project === undefined ? "nx" : overrides.project,
    agentId: null,
    createdAt: new Date(),
  } as never;
}

describe("manager rate-throttle", () => {
  it("throttle disabled → no downgrade even over threshold", async () => {
    const throttle = makeRateThrottleStub({ enabled: false, maxPerWindow: 5, windowMinutes: 5, recentCount: 10 });
    const manager = new NotificationManager(stubDb, undefined, undefined, undefined, throttle);

    const row = await manager.send(makeSendInput("t-1"));
    expect(row.channel).toBe("tts");
  });

  it("under threshold → no downgrade", async () => {
    const throttle = makeRateThrottleStub({ enabled: true, maxPerWindow: 5, windowMinutes: 5, recentCount: 2 });
    const manager = new NotificationManager(stubDb, undefined, undefined, undefined, throttle);

    const row = await manager.send(makeSendInput("t-2"));
    expect(row.channel).toBe("tts");
  });

  it("at threshold → downgraded to desktop", async () => {
    const throttle = makeRateThrottleStub({ enabled: true, maxPerWindow: 5, windowMinutes: 5, recentCount: 5 });
    const manager = new NotificationManager(stubDb, undefined, undefined, undefined, throttle);

    const row = await manager.send(makeSendInput("t-3"));
    expect(row.channel).toBe("desktop");
  });

  it("priority:high is never downgraded, regardless of count", async () => {
    const throttle = makeRateThrottleStub({ enabled: true, maxPerWindow: 5, windowMinutes: 5, recentCount: 50 });
    const manager = new NotificationManager(stubDb, undefined, undefined, undefined, throttle);

    const row = await manager.send(makeSendInput("t-4", { priority: "high" }));
    expect(row.channel).toBe("tts");
    expect(throttle.countRecent).not.toHaveBeenCalled();
  });

  it("project-less notifications are never throttled", async () => {
    const throttle = makeRateThrottleStub({ enabled: true, maxPerWindow: 5, windowMinutes: 5, recentCount: 50 });
    const manager = new NotificationManager(stubDb, undefined, undefined, undefined, throttle);

    const row = await manager.send(makeSendInput("t-5", { project: null }));
    expect(row.channel).toBe("tts");
    expect(throttle.countRecent).not.toHaveBeenCalled();
  });

  it("no rateThrottle wiring at all → byte-identical legacy behavior", async () => {
    const manager = new NotificationManager(stubDb);
    const row = await manager.send(makeSendInput("t-6"));
    expect(row.channel).toBe("tts");
  });
});
