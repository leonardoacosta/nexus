/**
 * NotificationManager audio-attachment tests.
 *
 * Spec: restore-tts-mac-audio-dispatch §2.3
 *
 * Verifies the manager threads `audioBase64` from the TTS channel result
 * into the `NotificationFired` lifecycle envelope. Other channels emit
 * without audio.
 *
 * The DB layer is mocked because these tests run without a live PG.
 */

import {
  describe,
  expect,
  it,
  spyOn,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import { installNexusDbMock } from "../testing/mock-nexus-db";
import { installCoreNodeMock } from "../testing/mock-core-node";
import { installBufferMock, type BufferMockHandle } from "./testing-mocks";
import * as routerNs from "./router";

// ─── Shared mocks (nx-509z5) ────────────────────────────────────────────────
// @nexus/db + @nexus/core/node spread the REAL barrel (complete, drift-proof,
// safe under last-writer-wins). @nexus/db keeps createDb real; core/node keeps
// every export but the logger real. ./buffer + ./router + the bus are SPIED in
// beforeAll / restored in afterAll (RESTORABLE — only active for THIS suite's
// tests, so siblings that run later get the real modules).

installNexusDbMock();
installCoreNodeMock();

// ─── Now load the system under test (REAL router + REAL lifecycle bus) ─────

const { NotificationManager } = await import("./manager");
const { lifecycleBus } = await import("../services/lifecycle-bus");

// Spy on the REAL router + bus + buffer in beforeAll / restore in afterAll
// (NOT module-eval-time mock.module). spyOn is RESTORABLE and, scoped to
// beforeAll/afterAll, is only ACTIVE during THIS suite's tests — so sibling
// suites that run later (router.test.ts tests the REAL routeNotificationParallel;
// manager.integration needs the REAL bus; reliability-regression calls the REAL
// insertNotification) are never polluted. mock.module is process-global +
// irreversible, which is exactly what caused nx-509z5.
//
// The manager's static `import { routeNotificationParallel }` / `lifecycleBus`
// see these spies via ESM live bindings.
let routeNotificationParallelMock: ReturnType<typeof spyOn>;
let lifecycleEmitMock: ReturnType<typeof spyOn>;
let bufferMock: BufferMockHandle;

beforeAll(() => {
  bufferMock = installBufferMock();
  routeNotificationParallelMock = spyOn(
    routerNs,
    "routeNotificationParallel",
  ).mockImplementation(async () => ({
    delivered: [],
    failed: [],
  }));
  // No-op the real fan-out; this suite asserts on the recorded calls only and
  // the manager ignores emit's return value.
  lifecycleEmitMock = spyOn(lifecycleBus, "emit").mockImplementation(
    () => undefined as never,
  );
});

afterAll(() => {
  routeNotificationParallelMock.mockRestore();
  lifecycleEmitMock.mockRestore();
  bufferMock.restore();
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeNotification(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "audio-emit-1",
    title: "Build complete",
    body: "tests green",
    channel: "tts",
    priority: "normal",
    status: "queued",
    project: "nx",
    agentId: null,
    createdAt: new Date(),
    sentAt: null,
    ...overrides,
  };
}

// Minimal stand-in for the Db type — manager only stores it for buffer calls.
const stubDb = {} as unknown as Parameters<typeof NotificationManager>[0];

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("NotificationManager.deliverNotification — audio attachment", () => {
  beforeEach(() => {
    routeNotificationParallelMock.mockClear();
    lifecycleEmitMock.mockClear();
  });

  afterEach(() => {
    routeNotificationParallelMock.mockClear();
    lifecycleEmitMock.mockClear();
  });

  it("attaches audioBase64 to NotificationFired when TTS channel returns audio", async () => {
    const audio = Buffer.from(new Uint8Array([1, 2, 3, 4, 5])).toString(
      "base64",
    );
    routeNotificationParallelMock.mockImplementationOnce(async () => ({
      delivered: [{ channel: "tts", audioBase64: audio }],
      failed: [],
    }));

    const manager = new NotificationManager(stubDb);
    const notif = makeNotification({ id: "with-audio" });

    // Cast: makeNotification returns the manager's expected shape.
    await manager.send(notif as never);

    expect(lifecycleEmitMock).toHaveBeenCalled();
    const [event, payload] = lifecycleEmitMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(event).toBe("NotificationFired");
    expect(payload.id).toBe("with-audio");
    expect(payload.channel).toBe("tts");
    expect(payload.audioBase64).toBe(audio);
  });

  it("omits audioBase64 when channel returns no audio (e.g. desktop)", async () => {
    routeNotificationParallelMock.mockImplementationOnce(async () => ({
      delivered: [{ channel: "desktop" }],
      failed: [],
    }));

    const manager = new NotificationManager(stubDb);
    const notif = makeNotification({ id: "no-audio", channel: "desktop" });

    await manager.send(notif as never);

    expect(lifecycleEmitMock).toHaveBeenCalled();
    const [event, payload] = lifecycleEmitMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(event).toBe("NotificationFired");
    expect(payload.audioBase64).toBeUndefined();
  });

  it("emits one NotificationFired per delivered channel, with audio attached only to TTS", async () => {
    const audio = Buffer.from(new Uint8Array([9, 8, 7])).toString("base64");
    routeNotificationParallelMock.mockImplementationOnce(async () => ({
      delivered: [
        { channel: "desktop" },
        { channel: "tts", audioBase64: audio },
        { channel: "slack" },
      ],
      failed: [],
    }));

    const manager = new NotificationManager(stubDb);
    const notif = makeNotification({ id: "fanout" });

    await manager.send(notif as never);

    expect(lifecycleEmitMock).toHaveBeenCalledTimes(3);

    const channels = lifecycleEmitMock.mock.calls.map(
      (call: unknown[]) => (call[1] as { channel: string }).channel,
    );
    expect(channels).toEqual(["desktop", "tts", "slack"]);

    const audios = lifecycleEmitMock.mock.calls.map(
      (call: unknown[]) => (call[1] as { audioBase64?: string }).audioBase64,
    );
    expect(audios).toEqual([undefined, audio, undefined]);
  });
});
