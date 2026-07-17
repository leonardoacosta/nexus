/**
 * Manager quiet-hours gate tests (noise-reduction audit 2026-07-13, plan 042).
 *
 * Covers: disabled → no downgrade; enabled + inside the window →
 * tts downgraded to desktop; enabled + outside the window → no downgrade;
 * priority:"high" is never downgraded; no quietHours wiring → byte-identical
 * legacy behavior.
 *
 * The "inside/outside window" tests compute the current wall-clock hour and
 * build a 1-hour-wide window around it, so they are deterministic regardless
 * of when the suite runs (no fake timers needed).
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

const { NotificationManager } = await import("./manager");

const stubDb = {} as never;

function makeQuietHoursStub(opts: {
  enabled: boolean;
  startHour: number;
  endHour: number;
}) {
  return {
    settings: mock(async () => ({
      enabled: opts.enabled,
      startHour: opts.startHour,
      endHour: opts.endHour,
    })),
  };
}

function makeSendInput(
  id: string,
  overrides: Partial<{ priority: string; project: string | null }> = {},
) {
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

describe("manager quiet-hours gate", () => {
  it("disabled → no downgrade even inside the window", async () => {
    const h = new Date().getHours();
    const quietHours = makeQuietHoursStub({
      enabled: false,
      startHour: h,
      endHour: (h + 1) % 24,
    });
    const manager = new NotificationManager(
      stubDb,
      undefined,
      undefined,
      undefined,
      undefined,
      quietHours,
    );
    const row = await manager.send(makeSendInput("q-1"));
    expect(row.channel).toBe("tts");
  });

  it("enabled + inside the current-hour window → downgraded to desktop", async () => {
    const h = new Date().getHours();
    const quietHours = makeQuietHoursStub({
      enabled: true,
      startHour: h,
      endHour: (h + 1) % 24,
    });
    const manager = new NotificationManager(
      stubDb,
      undefined,
      undefined,
      undefined,
      undefined,
      quietHours,
    );
    const row = await manager.send(makeSendInput("q-2"));
    expect(row.channel).toBe("desktop");
  });

  it("enabled + outside the window → no downgrade", async () => {
    const h = new Date().getHours();
    const quietHours = makeQuietHoursStub({
      enabled: true,
      startHour: (h + 2) % 24,
      endHour: (h + 3) % 24,
    });
    const manager = new NotificationManager(
      stubDb,
      undefined,
      undefined,
      undefined,
      undefined,
      quietHours,
    );
    const row = await manager.send(makeSendInput("q-3"));
    expect(row.channel).toBe("tts");
  });

  it('priority:"high" is never downgraded, regardless of window', async () => {
    const h = new Date().getHours();
    const quietHours = makeQuietHoursStub({
      enabled: true,
      startHour: h,
      endHour: (h + 1) % 24,
    });
    const manager = new NotificationManager(
      stubDb,
      undefined,
      undefined,
      undefined,
      undefined,
      quietHours,
    );
    const row = await manager.send(makeSendInput("q-4", { priority: "high" }));
    expect(row.channel).toBe("tts");
    expect(quietHours.settings).not.toHaveBeenCalled();
  });

  it("no quietHours wiring at all → byte-identical legacy behavior", async () => {
    const manager = new NotificationManager(stubDb);
    const row = await manager.send(makeSendInput("q-5"));
    expect(row.channel).toBe("tts");
  });
});
