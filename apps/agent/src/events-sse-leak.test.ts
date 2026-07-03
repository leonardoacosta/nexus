/**
 * Regression test for plan 010 — SSE lifecycle-bus subscriber leak.
 *
 * Each open /events/stream subscribes a wildcard handler to the global
 * lifecycleBus. The handler unsubscribed ONLY inside the stream's cancel()
 * callback; an abnormal close where cancel() never fired left a dead handler
 * registered forever, and every subsequent bus emit invoked its failing
 * enqueue (re-throwing out of emit() and leaking the subscriber). The fix:
 * the busHandler catch calls the idempotent cleanup() the first time an
 * enqueue throws — offAny's itself off the bus without waiting for cancel().
 *
 * These tests drive that exact failure path via `subscribeStreamToBus` — the
 * production wiring extracted from `handleEventsStream`. We capture a REAL
 * ReadableStream controller, `close()` it (producer-side close does NOT fire
 * the stream's cancel() callback — verified), which makes a subsequent
 * `enqueue()` throw, then emit on the bus. The seam's catch must self-clean.
 *
 * Why not drive this through a real HTTP fetch: a client-side abort/cancel in
 * Bun's in-process harness routes teardown through the server cancel() callback,
 * which already unsubscribes on UNFIXED code — so an abort-based test passes
 * regardless of the fix (tautology). Only the enqueue-throw-WITHOUT-cancel path
 * exercises the actual fix, and `controller.close()` is the one way to reach
 * that state deterministically from a test.
 */

import { describe, expect, it } from "bun:test";
import { lifecycleBus } from "./services/lifecycle-bus";
import { subscribeStreamToBus } from "./routes/events-sse";

/**
 * Capture a real ReadableStream controller — the exact object the SSE handler
 * enqueues into. `start()` runs synchronously during construction.
 */
function captureController(): ReadableStreamDefaultController<Uint8Array> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return controller;
}

describe("SSE lifecycle-bus subscriber leak (plan 010)", () => {
  it("self-cleans the bus subscriber when a bus emit's enqueue throws (abnormal close, no cancel)", () => {
    const baseline = lifecycleBus.wildcardListenerCount;

    const controller = captureController();
    const { cleanup } = subscribeStreamToBus(controller);
    expect(lifecycleBus.wildcardListenerCount).toBe(baseline + 1);

    // Abnormal-close state: producer side closed (enqueue now throws) but the
    // stream's cancel() callback never fired — the leak this fix targets.
    controller.close();

    // A bus emit drives the still-registered handler through a failing enqueue.
    // FIXED:   busHandler catch -> cleanup() -> offAny -> count == baseline.
    // UNFIXED: enqueue TypeError propagates out of emit(), handler stays
    //          subscribed -> count == baseline + 1 (leak).
    try {
      lifecycleBus.emit("SessionStopped", { sessionId: "seam-leak-test" });
    } catch {
      // On unfixed code the uncaught enqueue error propagates out of emit();
      // swallow it so the assertion below is the load-bearing signal.
    }

    expect(lifecycleBus.wildcardListenerCount).toBe(baseline);
    cleanup(); // no-op if already cleaned; keeps the bus pristine on failure
  });

  it("cleanup is idempotent — enqueue-failure self-clean + a later cancel() stay at baseline", () => {
    const baseline = lifecycleBus.wildcardListenerCount;

    const controller = captureController();
    const { cleanup } = subscribeStreamToBus(controller);
    expect(lifecycleBus.wildcardListenerCount).toBe(baseline + 1);

    controller.close();
    try {
      lifecycleBus.emit("SessionStopped", { sessionId: "idem-enqueue" });
    } catch {
      /* unfixed re-throw swallowed */
    }
    // busHandler already self-cleaned on the failing enqueue.
    expect(lifecycleBus.wildcardListenerCount).toBe(baseline);

    // Simulate cancel() firing AFTER the self-clean already ran — the `closed`
    // guard must make this a no-op, not double-offAny below baseline.
    cleanup();
    cleanup();
    expect(lifecycleBus.wildcardListenerCount).toBe(baseline);
  });
});
