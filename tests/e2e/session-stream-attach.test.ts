/**
 * E2E (nx-omso0): /sessions/:id/stream lazy-attaches a tmux-backed PtySource.
 *
 * Regression guard for the "session stream 404" bug: the process-watcher
 * inserts session rows with `tmux_session` + `tmux_target` populated but
 * never calls `streamManager.attach(...)`. Before this fix every viewer
 * click on a discovered session 404'd at the WS upgrade because
 * `streamManager.getPty(sessionId)` returned null.
 *
 * What the test does:
 *   1. Bootstrap a real tmux session backing the row.
 *   2. Insert a `sessions` row pointing at that tmux target via the agent's
 *      drizzle handle.
 *   3. Start a real nexus-agent HTTP server bound to a random port WITH a
 *      DB handle (so lazy-attach is enabled).
 *   4. Connect a WebSocket to /sessions/<id>/stream.
 *   5. Assert: upgrade succeeds (no 404, no 4004 close), initial scrollback
 *      arrives, and bytes injected via `tmux send-keys` are forwarded.
 *
 * Skip conditions:
 *   - `POSTGRES_URL` unset (no DB to insert into).
 *   - `tmux` binary not on PATH (no real pane to stream).
 *
 * Unrelated to (kept distinct from) `attach-websocket.test.ts`:
 *   - That file uses MockPtySource + an in-memory streamManager.attach() to
 *     prove the WS plumbing — it does NOT exercise the lazy-attach DB lookup
 *     or the tmux PtySource. This file does both.
 */

import {
  describe,
  expect,
  it,
  afterAll,
  beforeAll,
} from "bun:test";

const POSTGRES_URL = process.env.POSTGRES_URL;
const TMUX_AVAILABLE = Bun.which("tmux") !== null;
const SHOULD_RUN = !!POSTGRES_URL && TMUX_AVAILABLE;

if (!SHOULD_RUN) {
  // Make the skip reason visible in CI logs.
  // eslint-disable-next-line no-console
  console.warn(
    `session-stream-attach.test.ts: skipping — POSTGRES_URL=${!!POSTGRES_URL} tmux=${TMUX_AVAILABLE}`,
  );
}

// Lazy-import server + DB only when the suite will actually run, to avoid
// the agent module's encryption-key checks tripping when POSTGRES_URL is unset.
let server: { port: number; stop: (closeActive?: boolean) => void } | null = null;
let db: import("../../packages/db/src/index").Db | null = null;
let httpBase = "";
let wsBase = "";
const TMUX_SESSION_NAME = `nexus-e2e-stream-${process.pid}-${Date.now()}`;
let TMUX_TARGET = TMUX_SESSION_NAME; // resolved after spawn via list-panes
const SESSION_ID = `e2e-stream-${process.pid}-${Date.now()}`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decode(data: Uint8Array | ArrayBuffer): string {
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  return new TextDecoder().decode(data);
}

async function spawnTmuxSession(): Promise<string> {
  // -d = detached; -s = session name; spawn an interactive bash so we have a
  // real pty backing the pane that we can pipe-pane against.
  const proc = Bun.spawn(
    ["tmux", "new-session", "-d", "-s", TMUX_SESSION_NAME, "bash", "--noprofile", "--norc"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tmux new-session failed (exit ${code}): ${err}`);
  }
  // Resolve the actual pane target — tmux base-index varies across configs.
  const listProc = Bun.spawn(
    ["tmux", "list-panes", "-t", TMUX_SESSION_NAME, "-F", "#S:#I.#P"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(listProc.stdout).text();
  await listProc.exited;
  const target = out.trim().split("\n")[0];
  if (!target) {
    throw new Error(`tmux list-panes returned empty: ${out}`);
  }
  return target;
}

async function killTmuxSession(): Promise<void> {
  try {
    const proc = Bun.spawn(["tmux", "kill-session", "-t", TMUX_SESSION_NAME], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch {
    // best-effort
  }
}

async function tmuxSendKeys(text: string): Promise<void> {
  const proc = Bun.spawn(
    ["tmux", "send-keys", "-t", TMUX_TARGET, text, "Enter"],
    { stdout: "ignore", stderr: "pipe" },
  );
  await proc.exited;
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  // Imports are deferred so test-file load does not pull the agent module
  // (which validates POSTGRES_URL / encryption keys at module load).
  process.env.NEXUS_ENCRYPTION_KEY ??= "0".repeat(64); // 32-byte hex, test-only
  const { openDatabase } = await import("../../apps/agent/src/db/database");
  const { startServer } = await import("../../apps/agent/src/server");
  // Use a relative path into @nexus/db rather than the package name —
  // tests/e2e is a workspace package but lacks an installed node_modules
  // link to @nexus/db. The relative import mirrors attach-websocket.test.ts.
  const { sessions } = await import("../../packages/db/src/index");

  db = openDatabase(POSTGRES_URL);

  // Spawn tmux FIRST so we know the real pane target (base-index varies).
  TMUX_TARGET = await spawnTmuxSession();

  // Insert the session row that the agent will lazy-attach to.
  // We bypass the in-memory SessionManager — the lazy-attach path reads
  // directly from the DB via getSessionById.
  //
  // pid is intentionally NULL: the process-watcher's reconcile pass closes
  // any row whose pid is set but not in `pgrep -af claude`. With pid NULL
  // (or 0) the row falls outside the watcher's predicate (pid > 0).
  await db.insert(sessions).values({
    id: SESSION_ID,
    machine: "local",
    status: "active",
    startedAt: new Date(),
    lastActivity: new Date(),
    endedAt: null,
    pid: null,
    cwd: process.cwd(),
    branch: null,
    sessionType: null,
    model: null,
    rateLimitUtilization: null,
    totalCostUsd: null,
    rateLimitResetAt: null,
    idleSince: null,
    projectId: null,
    ccSessionId: null,
    tmuxSession: TMUX_SESSION_NAME,
    tmuxTarget: TMUX_TARGET,
    spec: null,
    credentialId: null,
    credentialFingerprint: null,
    gitProvider: null,
    gitOwnerRepo: null,
    parentSessionId: null,
    childRole: null,
  });

  server = startServer(0, db);
  httpBase = `http://localhost:${server.port}`;
  wsBase = `ws://localhost:${server.port}`;
});

afterAll(async () => {
  if (!SHOULD_RUN) return;
  try {
    server?.stop(true);
  } catch {
    // ignore
  }
  await killTmuxSession();
  if (db) {
    const { sessions, eq } = await import("../../packages/db/src/index");
    try {
      await db.delete(sessions).where(eq(sessions.id, SESSION_ID));
    } catch {
      // ignore
    }
  }
});

describe.skipIf(!SHOULD_RUN)(
  "E2E (nx-omso0): /sessions/:id/stream lazy-attaches tmux PtySource",
  () => {
    it("pre-flight: agent is up", async () => {
      const res = await fetch(`${httpBase}/health`);
      expect([200, 204].includes(res.status)).toBe(true);
    });

    it("first viewer connect triggers lazy attach and streams pane output", async () => {
      const ws = new WebSocket(`${wsBase}/sessions/${SESSION_ID}/stream`);
      ws.binaryType = "arraybuffer";

      const binaryMessages: Uint8Array[] = [];
      const opened = new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("ws error before open")));
        ws.addEventListener("close", (ev) => {
          // 4004 = session not found; surface as failure rather than silent timeout.
          if (ev.code === 4004) reject(new Error(`ws closed 4004: ${ev.reason}`));
        });
      });
      ws.addEventListener("message", (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          binaryMessages.push(new Uint8Array(ev.data));
        }
      });

      // Connection must upgrade — bug was 404 here.
      await opened;
      expect(ws.readyState).toBe(WebSocket.OPEN);

      // Drive output through tmux send-keys. The TmuxPtySource's pipe-pane
      // child captures pane output and forwards it as binary frames.
      await tmuxSendKeys("echo nexus-e2e-stream-hello");

      // Allow tmux to render + pipe-pane to flush + WS fan-out.
      const deadline = Date.now() + 4_000;
      let delivered = "";
      while (Date.now() < deadline) {
        await delay(100);
        delivered = binaryMessages.map(decode).join("");
        if (delivered.includes("nexus-e2e-stream-hello")) break;
      }
      expect(delivered).toContain("nexus-e2e-stream-hello");

      ws.close();
      await delay(50);
    });

    it("subsequent viewer connects use the already-attached stream", async () => {
      // First connect from the previous test should have left the PTY attached
      // (the close path only ends the session when viewerCount drops to 0,
      // but in our race we may have closed it). Either way, this second
      // connect MUST succeed — either fast-path or another lazy attach.
      const ws = new WebSocket(`${wsBase}/sessions/${SESSION_ID}/stream`);
      const opened = new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("ws error before open")));
        ws.addEventListener("close", (ev) => {
          if (ev.code === 4004) reject(new Error(`ws closed 4004: ${ev.reason}`));
        });
      });
      await opened;
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await delay(50);
    });

    it("unknown session id still returns 404 (no lazy attach)", async () => {
      const res = await fetch(`${httpBase}/sessions/no-such-session-xyz/stream`);
      expect(res.status).toBe(404);
    });
  },
);
