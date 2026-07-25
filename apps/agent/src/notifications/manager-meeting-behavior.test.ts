/**
 * Manager legacy meeting-behavior gate (`manager.ts:334-352`).
 *
 * Real coverage for two behaviors that existed only as `expect(true)`
 * placeholders in `notifications.test.ts` (`tts-degradation-test-coverage`
 * task 1.3): `meeting_behavior: "drop"` expires the row during a meeting, and
 * `"allow"` falls through to delivery. `"buffer"` (the default) is covered
 * here too since it shares the same branch.
 *
 * This is the NON-presence path — the gate `send()` reaches when presence-aware
 * routing yields no decision. The presence-aware meeting hold (Rule 2) is
 * covered separately by `rules-engine.test.ts` + `manager-presence.test.ts`.
 *
 * Harness mirrors `manager-quiet-hours.test.ts`: shared db/core-node mocks plus
 * the RESTORABLE buffer spy handle (nx-509z5) so the no-op DB writers never
 * leak into sibling suites.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
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
  setRoutingRules([]);
});

const { NotificationManager } = await import("./manager");
const { MeetingState } = await import("./meeting-state");
const { setRoutingRules } = await import("./router");

const stubDb = {} as never;

function makeSendInput(id: string, project: string) {
  return {
    id,
    title: "meeting gate",
    body: "body",
    channel: "desktop",
    priority: "normal",
    project,
    agentId: null,
    createdAt: new Date(),
  } as never;
}

/** Manager with an ACTIVE meeting and no presence wiring (legacy gate path). */
function managerInMeeting() {
  const meeting = new MeetingState();
  meeting.start();
  return new NotificationManager(stubDb, meeting);
}

describe("manager meeting-behavior gate (legacy, non-presence path)", () => {
  it('rule "drop": expires the notification during a meeting', async () => {
    setRoutingRules([
      { project: "drop-proj", channels: ["desktop"], meeting_behavior: "drop" },
    ]);
    const row = await managerInMeeting().send(makeSendInput("m-drop", "drop-proj"));
    expect(row.status).toBe("expired");
  });

  it('rule "allow": falls through to delivery during a meeting', async () => {
    setRoutingRules([
      { project: "allow-proj", channels: ["desktop"], meeting_behavior: "allow" },
    ]);
    const row = await managerInMeeting().send(makeSendInput("m-allow", "allow-proj"));
    expect(row.status).toBe("delivered");
  });

  it('rule "buffer": stays queued during a meeting (flushed when it ends)', async () => {
    setRoutingRules([
      { project: "buf-proj", channels: ["desktop"], meeting_behavior: "buffer" },
    ]);
    const row = await managerInMeeting().send(makeSendInput("m-buffer", "buf-proj"));
    expect(row.status).toBe("queued");
  });

  it("no active meeting: the gate is skipped even for a drop rule", async () => {
    setRoutingRules([
      { project: "drop-proj", channels: ["desktop"], meeting_behavior: "drop" },
    ]);
    const manager = new NotificationManager(stubDb);
    const row = await manager.send(makeSendInput("m-nomeeting", "drop-proj"));
    expect(row.status).toBe("delivered");
  });
});
