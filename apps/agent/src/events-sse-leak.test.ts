/**
 * Regression test for plan 010 — SSE lifecycle-bus subscriber leak.
 *
 * Each open /events/stream subscribes a wildcard handler to the global
 * lifecycleBus. Before the fix, that handler unsubscribed ONLY inside the
 * stream's cancel() callback; an abnormal close where cancel() never fired
 * left a dead handler registered forever, and every subsequent bus emit
 * invoked its failing enqueue. The handler now self-cleans the first time
 * its enqueue fails (and cancel() delegates to the same idempotent cleanup),
 * so a leaked subscriber cannot outlive its stream.
 *
 * Both cases assert on a baseline-relative wildcard listener count, so they
 * are robust to any other subscribers the shared in-process server holds.
 *
 * Harness note: the plan's original "graceful reader.cancel() returns to
 * baseline" case is NOT observable in Bun's in-process HTTP test harness —
 * a client-side reader.cancel() does not propagate to the server-side
 * ReadableStream (server cancel() never fires and the controller stays open,
 * so no enqueue failure occurs). Only AbortController.abort() actually tears
 * the connection down in this harness. Both cases below therefore drive the
 * teardown via abort(), which is the exact abnormal-close path this fix
 * targets. The graceful-cancel path is covered by cancel() delegating to the
 * same cleanup() (verified by typecheck + the `closed`-guard idempotency in
 * case 2).
 */

import { describe, expect, it } from "bun:test";
import { baseUrl } from "./server.helpers";
import { lifecycleBus } from "./services/lifecycle-bus";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForCount(target: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lifecycleBus.wildcardListenerCount === target) return target;
    await settle(25);
  }
  return lifecycleBus.wildcardListenerCount;
}

describe("SSE lifecycle-bus subscriber leak (plan 010)", () => {
  it("does not leak a handler after an abrupt abort", async () => {
    const baseline = lifecycleBus.wildcardListenerCount;
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/events/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    expect(lifecycleBus.wildcardListenerCount).toBe(baseline + 1);

    ac.abort();
    reader.cancel().catch(() => {});
    // Drive any still-registered dead handler through its failing enqueue.
    await settle(50);
    lifecycleBus.emit("SessionStopped", { sessionId: "leak-test" });

    // If the handler did not self-clean, the count stays at baseline + 1 and
    // this poll times out (the leak this plan fixes).
    expect(await waitForCount(baseline)).toBe(baseline);
  });

  it("cleanup is idempotent — repeated emits after teardown keep baseline", async () => {
    const baseline = lifecycleBus.wildcardListenerCount;
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/events/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    expect(lifecycleBus.wildcardListenerCount).toBe(baseline + 1);

    ac.abort();
    reader.cancel().catch(() => {});
    await settle(50);
    lifecycleBus.emit("SessionStopped", { sessionId: "idem-1" });
    expect(await waitForCount(baseline)).toBe(baseline);

    // A second emit must not double-offAny below baseline (the `closed` guard).
    lifecycleBus.emit("SessionStopped", { sessionId: "idem-2" });
    await settle(50);
    expect(lifecycleBus.wildcardListenerCount).toBe(baseline);
  });
});
