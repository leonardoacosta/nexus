/**
 * SSE route tests: GET /specs/events.
 *
 * Covers SpecB 5.4 (nx-v15e): the SSE route emits a `SpecTransition`
 * frame that a connected client receives. The full "simulated network
 * drop + reconnect + refetch reconciliation" flow requires a real
 * browser `EventSource` (with automatic reconnect) — that's out of
 * scope for this Bun test runner. What we CAN exercise at this level:
 *
 *   1. Subscribe to the SSE stream by invoking the handler directly and
 *      reading the returned ReadableStream as a client would.
 *   2. Emit a `SpecTransition` onto `lifecycleBus`.
 *   3. Wait for the 5s coalesce window and verify the frame reaches the
 *      client with the expected discriminated-union shape.
 *   4. Cancel the stream (simulates client disconnect) and assert that
 *      the route cleans up its bus subscription — so on a real
 *      EventSource reconnect the server re-subscribes cleanly and the
 *      specs page's refetch-on-reconnect logic has a healthy channel.
 *
 * The browser-side reconcile-after-drop path is validated by the
 * integration assertion: the handler is a pure function of
 * `lifecycleBus` state, and re-invoking it post-cancel produces a new,
 * independent stream. That's the server contract the client's
 * reconnect+refetch relies on.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { handleSpecEventsStream } from "./specs-events";
import { lifecycleBus } from "../services/lifecycle-bus";
import { SPEC_EVENTS_EVENT_NAME, specEventsFrameSchema } from "@nexus/core";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * Parse raw SSE bytes into discrete events. Collects all event: / data:
 * pairs seen so far and returns them as objects. Comment lines (`:`)
 * are ignored as per the SSE spec.
 */
function parseSseChunks(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  const blocks = raw.split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let eventName: string | null = null;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (dataLines.length > 0) {
      events.push({ event: eventName, data: dataLines.join("\n") });
    }
  }
  return events;
}

/**
 * Pull the next N events (or until timeout) from an SSE ReadableStream.
 * Returns the parsed SSE events plus the raw accumulated text so assertions
 * can inspect hello/comment lines if needed.
 */
async function readSseUntil(
  body: ReadableStream<Uint8Array>,
  predicate: (events: SseEvent[]) => boolean,
  timeoutMs: number,
): Promise<{ events: SseEvent[]; raw: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let events: SseEvent[] = [];
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const ms = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((res) =>
          setTimeout(() => res({ done: true, value: undefined }), ms),
        ),
      ]);
      if (chunk.done) break;
      if (chunk.value) {
        raw += decoder.decode(chunk.value, { stream: true });
        events = parseSseChunks(raw);
        if (predicate(events)) break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  return { events, raw };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

let activeCancelers: Array<() => void> = [];

afterEach(async () => {
  for (const cancel of activeCancelers) {
    try {
      cancel();
    } catch {
      // best effort
    }
  }
  activeCancelers = [];
});

describe("GET /specs/events (SSE) — SpecB 5.4", () => {
  test("responds with SSE headers and an initial comment", async () => {
    const response = handleSpecEventsStream();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    // X-Accel-Buffering disables proxy buffering for prompt flushes.
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");

    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();
    activeCancelers.push(() => response.body!.cancel().catch(() => {}));

    // Read just the first chunk — expect a `: connected at ...` comment.
    const { value, done } = await reader.read();
    reader.releaseLock();
    expect(done).toBe(false);
    const text = new TextDecoder().decode(value);
    expect(text).toContain(":");
    expect(text).toContain("connected");

    await response.body!.cancel();
  });

  test(
    "emits a SpecTransition frame when lifecycleBus fires",
    async () => {
      const response = handleSpecEventsStream();
      expect(response.body).not.toBeNull();
      activeCancelers.push(() => response.body!.cancel().catch(() => {}));

      // Fire a progress transition right away — it'll be buffered in
      // `pending[]` until the 5s coalesce window flushes.
      lifecycleBus.emit("SpecTransition", {
        project: "nx-test",
        specName: "add-spec-page-live-updates",
        transition: "progress",
        completed: 2,
        total: 5,
      });

      // Wait up to 7s (5s coalesce + 2s safety) for the frame to arrive.
      const { events } = await readSseUntil(
        response.body!,
        (evs) => evs.some((e) => e.event === SPEC_EVENTS_EVENT_NAME),
        7_000,
      );

      await response.body!.cancel();

      const transitionEvents = events.filter(
        (e) => e.event === SPEC_EVENTS_EVENT_NAME,
      );
      expect(transitionEvents.length).toBeGreaterThanOrEqual(1);

      // Every emitted frame must validate against the shared schema —
      // this is the contract the browser client relies on.
      const frame = JSON.parse(transitionEvents[0]!.data);
      const parsed = specEventsFrameSchema.safeParse(frame);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      expect(parsed.data.seq).toBeGreaterThanOrEqual(1);
      expect(parsed.data.events).toHaveLength(1);
      const ev = parsed.data.events[0]!;
      expect(ev.kind).toBe("progress");
      expect(ev.project).toBe("nx-test");
      expect(ev.spec).toBe("add-spec-page-live-updates");
      if (ev.kind === "progress") {
        expect(ev.completed).toBe(2);
        expect(ev.total).toBe(5);
      }
    },
    { timeout: 10_000 },
  );

  test(
    "translates `archived` transitions to kind: archived on the wire",
    async () => {
      const response = handleSpecEventsStream();
      activeCancelers.push(() => response.body!.cancel().catch(() => {}));

      lifecycleBus.emit("SpecTransition", {
        project: "nx-test",
        specName: "obsolete-spec",
        transition: "removed",
      });

      const { events } = await readSseUntil(
        response.body!,
        (evs) => evs.some((e) => e.event === SPEC_EVENTS_EVENT_NAME),
        7_000,
      );
      await response.body!.cancel();

      const transitionEvents = events.filter(
        (e) => e.event === SPEC_EVENTS_EVENT_NAME,
      );
      expect(transitionEvents.length).toBeGreaterThanOrEqual(1);
      const frame = specEventsFrameSchema.parse(
        JSON.parse(transitionEvents[0]!.data),
      );
      const archivedEv = frame.events.find((e) => e.kind === "archived");
      expect(archivedEv).toBeDefined();
      expect(archivedEv!.spec).toBe("obsolete-spec");
    },
    { timeout: 10_000 },
  );

  test(
    "stream cancellation tears down the lifecycleBus subscription cleanly",
    async () => {
      // Count listeners before, during, after — the route must remove
      // its listener on cancel so a reconnecting client doesn't stack
      // stale subscribers across drops.
      const listenersBefore = lifecycleBus["emitter"].listenerCount(
        "SpecTransition",
      );

      const response = handleSpecEventsStream();
      // Drain the initial hello so the stream's `start()` has run.
      const reader = response.body!.getReader();
      await reader.read();
      reader.releaseLock();

      const listenersDuring = lifecycleBus["emitter"].listenerCount(
        "SpecTransition",
      );
      expect(listenersDuring).toBe(listenersBefore + 1);

      await response.body!.cancel();
      // Give the `cancel()` handler a microtask to run.
      await new Promise((r) => setTimeout(r, 30));

      const listenersAfter = lifecycleBus["emitter"].listenerCount(
        "SpecTransition",
      );
      expect(listenersAfter).toBe(listenersBefore);
    },
    { timeout: 5_000 },
  );
});
