/**
 * Round-trip tests for GET /events/stream.
 *
 * Validates that envelopes emitted on the lifecycle bus are forwarded
 * verbatim to SSE subscribers via the existing `lifecycleBus.onAny`
 * subscription wired in `handleEventsStream()`.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { handleEventsStream } from "./events-sse";
import { lifecycleBus } from "../services/lifecycle-bus";

interface ParsedFrame {
  event?: string;
  data?: string;
  comment?: string;
}

/**
 * Read an SSE stream until `predicate` returns true on a parsed frame, or
 * until `timeoutMs` elapses. Returns all frames seen in order.
 */
interface MinimalReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

async function readUntil(
  reader: MinimalReader,
  predicate: (frame: ParsedFrame) => boolean,
  timeoutMs = 1_500,
): Promise<ParsedFrame[]> {
  const decoder = new TextDecoder();
  const frames: ParsedFrame[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const tick = Promise.race([
      reader.read(),
      new Promise<{ done: true; value?: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true }), remaining),
      ),
    ]);
    const { done, value } = await tick;
    if (done) break;
    if (value) buffer += decoder.decode(value, { stream: true });

    // Split on the SSE record terminator.
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const frame: ParsedFrame = {};
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) frame.comment = line.slice(1).trim();
        else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("data:"))
          frame.data = (frame.data ?? "") + line.slice(5).trim();
      }
      frames.push(frame);
      if (predicate(frame)) return frames;
      idx = buffer.indexOf("\n\n");
    }
  }
  return frames;
}

describe("GET /events/stream — SSE round-trip", () => {
  let activeReader: MinimalReader | null = null;

  afterEach(async () => {
    if (activeReader) {
      try {
        await activeReader.cancel();
      } catch {
        // ignore
      }
      activeReader = null;
    }
  });

  test("emits a 'connected' frame on subscribe", async () => {
    const res = handleEventsStream();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = res.body!.getReader() as unknown as MinimalReader;
    activeReader = reader;

    const frames = await readUntil(
      reader,
      (f) => Boolean(f.data && f.data.includes("connected")),
      1_000,
    );
    const connected = frames.find(
      (f) => f.data && f.data.includes("connected"),
    );
    expect(connected).toBeDefined();
    const parsed = JSON.parse(connected!.data!) as { type: string };
    expect(parsed.type).toBe("connected");
  });

  test("forwards HookEventReceived envelopes to subscribers", async () => {
    const res = handleEventsStream();
    const reader = res.body!.getReader() as unknown as MinimalReader;
    activeReader = reader;

    // Wait for the initial connected frame so the bus subscription is wired.
    await readUntil(
      reader,
      (f) => Boolean(f.data && f.data.includes("connected")),
      500,
    );

    // Emit a HookEventReceived on the singleton bus that handleEventsStream
    // subscribes to. Defer slightly so the reader is parked.
    queueMicrotask(() => {
      lifecycleBus.emit("HookEventReceived", {
        eventType: "tool_use_end",
        sessionId: "sse-roundtrip-1",
        eventId: 99,
        count: 3,
      });
    });

    const frames = await readUntil(
      reader,
      (f) => f.event === "HookEventReceived",
      1_500,
    );
    const hook = frames.find((f) => f.event === "HookEventReceived");
    expect(hook).toBeDefined();
    expect(hook!.data).toBeTruthy();

    // NOTE: `source: 'local' | 'peer'` was removed by remove-peer-connector
    // (commit d2e965e). LifecycleEnvelope no longer carries a source tag;
    // cross-machine awareness comes from clients reading agents.toml and
    // querying each agent directly.
    const envelope = JSON.parse(hook!.data!) as {
      event: string;
      payload: {
        eventType: string;
        sessionId: string;
        eventId: number;
        count?: number;
      };
    };
    expect(envelope.event).toBe("HookEventReceived");
    expect(envelope.payload.eventType).toBe("tool_use_end");
    expect(envelope.payload.sessionId).toBe("sse-roundtrip-1");
    expect(envelope.payload.eventId).toBe(99);
    expect(envelope.payload.count).toBe(3);
  });

  test("forwards multiple distinct lifecycle events in order", async () => {
    const res = handleEventsStream();
    const reader = res.body!.getReader() as unknown as MinimalReader;
    activeReader = reader;

    await readUntil(
      reader,
      (f) => Boolean(f.data && f.data.includes("connected")),
      500,
    );

    queueMicrotask(() => {
      lifecycleBus.emit("HookEventReceived", {
        eventType: "session_start",
        sessionId: "sse-multi-1",
        eventId: 1,
      });
      lifecycleBus.emit("HookEventReceived", {
        eventType: "session_stop",
        sessionId: "sse-multi-1",
        eventId: 2,
      });
    });

    const frames = await readUntil(
      reader,
      (f) =>
        f.event === "HookEventReceived" &&
        Boolean(f.data && f.data.includes("session_stop")),
      1_500,
    );
    const hookFrames = frames.filter((f) => f.event === "HookEventReceived");
    expect(hookFrames.length).toBeGreaterThanOrEqual(2);
    const types = hookFrames.map((f) => {
      const env = JSON.parse(f.data!) as { payload: { eventType: string } };
      return env.payload.eventType;
    });
    expect(types).toContain("session_start");
    expect(types).toContain("session_stop");
  });
});
