/**
 * E2E [5.3] (nx-cjz0): Attach still works via WebSocket when an agent is up.
 *
 * Regression guard for the finalize-audit-cleanup dual-path collapse. The UI
 * dashboard now reads exclusively from shared Postgres (Drizzle) and no longer
 * falls back to agent HTTP fan-out. This test proves that the agent's live
 * attach boundary — `/sessions/:id/stream` WebSocket — is still intact.
 *
 * What the test does:
 *   1. Spawn a real nexus-agent HTTP server on a random port.
 *   2. Register a MockPtySource against a synthetic session ID.
 *   3. Open a browser-style WebSocket with the auth token in the query-string
 *      (matches XTerminal's real flow — browsers can't set custom WS headers).
 *   4. Emit known output from the PTY.
 *   5. Assert the WS client receives that output as binary frames.
 *
 * What it does NOT test (out of scope here):
 *   - Interactive writes / stdin round-trip (covered by apps/agent/src/terminal/interact.test.ts).
 *   - Real tmux-backed PTY spawning (covered by [5.1] safeSpawn integration test, nx-sxji).
 *   - Dashboard DB read path (covered by [5.2] dashboard-offline.test.ts).
 *
 * Skip conditions: none — the test is fully hermetic. It binds to port 0, uses
 * a mock PTY, and requires no external binaries (no tmux, no Postgres).
 */

import { describe, expect, it, afterAll, beforeAll } from "bun:test";

// The agent server reads NEXUS_ATTACH_SECRET at module load and exits the
// process if it's missing. Set a deterministic value BEFORE importing the
// server module so `startServer` succeeds regardless of the caller's env.
const TEST_SECRET = "e2e-attach-test-secret";
process.env.NEXUS_ATTACH_SECRET = process.env.NEXUS_ATTACH_SECRET ?? TEST_SECRET;
const ATTACH_SECRET = process.env.NEXUS_ATTACH_SECRET!;

// Import after env setup.
const { startServer, streamManager } = await import("../../apps/agent/src/server");
const { MockPtySource } = await import("../../apps/agent/src/terminal/pty-source");

// Bind to a random free port — multiple test runs must not collide.
const server = startServer(0);
const wsBase = `ws://localhost:${server.port}`;
const httpBase = `http://localhost:${server.port}`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decode(data: string | Uint8Array | ArrayBuffer): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  return new TextDecoder().decode(data);
}

interface ConnectedWs {
  ws: WebSocket;
  binaryMessages: Uint8Array[];
  textMessages: string[];
  opened: Promise<void>;
}

function connectBrowserStyle(path: string, token: string): ConnectedWs {
  // Matches XTerminal.tsx: browsers append the token as a query-string
  // parameter because custom WebSocket upgrade headers are not allowed.
  const url = `${wsBase}${path}?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  const binaryMessages: Uint8Array[] = [];
  const textMessages: string[] = [];

  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      textMessages.push(ev.data);
    } else if (ev.data instanceof ArrayBuffer) {
      binaryMessages.push(new Uint8Array(ev.data));
    }
  });

  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () =>
      reject(new Error("ws error before open")),
    );
  });

  return { ws, binaryMessages, textMessages, opened };
}

afterAll(() => {
  // server.stop() doesn't always exist on the Bun server — best-effort close.
  try {
    (server as unknown as { stop?: (force?: boolean) => void }).stop?.(true);
  } catch {
    // ignore
  }
});

describe("E2E [5.3]: Attach via WebSocket when agent is up", () => {
  // ── Pre-flight: agent is actually listening ────────────────────────────────
  it("agent health endpoint responds (server is live)", async () => {
    const res = await fetch(`${httpBase}/health`, {
      headers: { "x-nexus-secret": ATTACH_SECRET },
    });
    // 200 or 204 both indicate the server is up — we don't care about the
    // exact health payload here, only that the HTTP boundary answers.
    expect([200, 204].includes(res.status)).toBe(true);
  });

  // ── Main regression: WebSocket opens and streams PTY output ────────────────
  it("client receives PTY output over /sessions/:id/stream", async () => {
    const sessionId = `e2e-attach-${Date.now()}`;
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sessionId, pty);

    const conn = connectBrowserStyle(
      `/sessions/${sessionId}/stream`,
      ATTACH_SECRET,
    );

    // If auth or routing is broken the open promise will never resolve and
    // the test will time out with a clear failure — better than a silent pass.
    await conn.opened;
    expect(conn.ws.readyState).toBe(WebSocket.OPEN);

    // Simulate CC writing output to the attached PTY.
    pty.emit("echo ready\nhello-from-pty\n");

    // Give the fan-out a moment to deliver.
    await delay(80);

    const delivered = conn.binaryMessages.map(decode).join("");
    expect(delivered).toContain("echo ready");
    expect(delivered).toContain("hello-from-pty");

    conn.ws.close();
    await delay(20);
    streamManager.endSession(sessionId);
  });

  // ── Negative control: wrong token rejected (auth boundary intact) ──────────
  it("WebSocket upgrade with wrong token is rejected", async () => {
    // Use HTTP fetch to inspect the upgrade rejection status — the WebSocket
    // API doesn't expose HTTP status codes cleanly, but a GET to the same URL
    // triggers the same auth check and returns the underlying status.
    const res = await fetch(
      `${httpBase}/sessions/some-session/stream?token=${encodeURIComponent("wrong-token")}`,
    );
    expect(res.status).toBe(401);
  });

  // ── Ensures the attach path is NOT coupled to the dashboard read path ──────
  //
  // Task context: the UI dashboard used to HTTP-fan-out to agents; that path
  // is gone. The agent WS attach path must remain independent of any UI/DB
  // state — it only cares about streamManager.getPty(sessionId). This test
  // verifies that explicit independence.
  it("stream works even with no DB connection configured on the agent", async () => {
    // startServer(0) in this file was invoked without a `db` argument — so
    // any DB-dependent routes would have been skipped at registration time.
    // If stream worked in the previous test, it worked without a DB. This
    // assertion is here to make the guarantee explicit in the spec log.
    const sessionId = `e2e-attach-no-db-${Date.now()}`;
    const pty = new MockPtySource({ intervalMs: 0 });
    streamManager.attach(sessionId, pty);

    const conn = connectBrowserStyle(
      `/sessions/${sessionId}/stream`,
      ATTACH_SECRET,
    );
    await conn.opened;

    pty.emit("no-db-path-ok\n");
    await delay(80);

    const delivered = conn.binaryMessages.map(decode).join("");
    expect(delivered).toContain("no-db-path-ok");

    conn.ws.close();
    await delay(20);
    streamManager.endSession(sessionId);
  });
});

// Keep beforeAll present so a future test file in the same suite can extend
// setup without re-importing the server (bun:test shares module state by default).
beforeAll(() => {
  // No-op — server.port is already bound at module load.
});
