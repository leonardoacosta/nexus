import { describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { StreamManager, type WsData } from "./stream-manager";
import { MockPtySource } from "./pty-source";

/**
 * Minimal mock of a Bun ServerWebSocket carrying WsData. Records close()
 * invocations so eviction (4009) is observable. Only the surface claimWriter /
 * addViewer / removeViewer touch is implemented.
 */
function makeMockSocket(sessionId: string, mode: "stream" | "interact" = "interact") {
  const closes: { code: number; reason: string }[] = [];
  const sock = {
    data: { sessionId, mode } satisfies WsData,
    closes,
    close(code: number, reason?: string) {
      closes.push({ code, reason: reason ?? "" });
    },
    // unused by claimWriter, but present so addViewer's geometry/scrollback path
    // (if ever exercised) does not throw.
    sendText() {},
    sendBinary() {},
    getBufferedAmount() {
      return 0;
    },
  };
  return sock as unknown as ServerWebSocket<WsData> & {
    closes: { code: number; reason: string }[];
  };
}

describe("StreamManager.claimWriter — symmetric last-open-wins (ios-session-navigation 1.1)", () => {
  it("evicts the prior holder when a second socket claims a held session", () => {
    const mgr = new StreamManager();
    const sid = "claim-evict";
    mgr.attach(sid, new MockPtySource({ intervalMs: 0 }));

    const first = makeMockSocket(sid);
    const second = makeMockSocket(sid);

    // First claim succeeds, no eviction yet.
    expect(mgr.claimWriter(first)).toBe(true);
    expect(mgr.isWriter(first)).toBe(true);
    expect(first.closes).toHaveLength(0);

    // Second claim WINS — prior holder evicted, writer flips to `second`.
    expect(mgr.claimWriter(second)).toBe(true);
    expect(mgr.isWriter(second)).toBe(true);
    expect(mgr.isWriter(first)).toBe(false);

    // The prior holder's socket received exactly one 4009 close (observable).
    expect(first.closes).toHaveLength(1);
    expect(first.closes[0]?.code).toBe(4009);
    expect(first.closes[0]?.reason).toContain("reclaimed");

    // The new opener is NOT closed.
    expect(second.closes).toHaveLength(0);

    mgr.endSession(sid);
  });

  it("re-claiming with the SAME socket is idempotent — no self-eviction", () => {
    const mgr = new StreamManager();
    const sid = "claim-idempotent";
    mgr.attach(sid, new MockPtySource({ intervalMs: 0 }));

    const only = makeMockSocket(sid);
    expect(mgr.claimWriter(only)).toBe(true);
    expect(mgr.claimWriter(only)).toBe(true);
    expect(only.closes).toHaveLength(0);
    expect(mgr.isWriter(only)).toBe(true);

    mgr.endSession(sid);
  });

  it("returns false for an unregistered (no-stream) session — cannot claim", () => {
    const mgr = new StreamManager();
    const orphan = makeMockSocket("never-attached");

    expect(mgr.claimWriter(orphan)).toBe(false);
    expect(mgr.isWriter(orphan)).toBe(false);
    expect(orphan.closes).toHaveLength(0);
  });
});
