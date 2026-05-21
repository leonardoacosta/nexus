/**
 * Tests for POST /commands/send-text.
 *
 * Spec: openspec/changes/session-attach-and-cwd-cap/specs/terminal-attach/spec.md
 *
 * Covers:
 *   1. valid sessionId with tmuxTarget → 200, tmux send-keys invoked
 *   2. unknown sessionId → 404, tmux NOT invoked
 *   3. empty/missing text → 400, tmux NOT invoked
 *
 * The route shells out to `tmux send-keys` via `node:child_process.spawn`.
 * We mock the child_process module so the test never spawns a real tmux
 * (and works on machines without tmux installed). The SessionManager is
 * a minimal stub matching the shape `handleSendText` reads.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── child_process mock — capture spawn calls + simulate `tmux` exit 0 ──

interface SpawnCall {
  command: string;
  args: ReadonlyArray<string>;
}
const spawnCalls: SpawnCall[] = [];

mock.module("node:child_process", () => ({
  spawn: (command: string, args: ReadonlyArray<string>) => {
    spawnCalls.push({ command, args: [...args] });
    // Minimal mock matching the route's usage: stderr.on('data'),
    // child.on('error'), child.on('close'). Returns exit code 0.
    const stderrListeners: Array<(chunk: Buffer) => void> = [];
    const exitListeners: Array<(code: number | null) => void> = [];
    const errorListeners: Array<(err: Error) => void> = [];
    void stderrListeners;
    void errorListeners;
    const child = {
      stderr: {
        on: (_event: string, cb: (chunk: Buffer) => void) => {
          stderrListeners.push(cb);
        },
      },
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === "close") {
          exitListeners.push(cb as (code: number | null) => void);
        } else if (event === "error") {
          errorListeners.push(cb as (err: Error) => void);
        }
      },
    };
    // Fire 'close' on next tick so the await in tmuxSendKeys resolves.
    queueMicrotask(() => {
      for (const cb of exitListeners) cb(0);
    });
    return child;
  },
}));

// Silence the route logger.
const loggerMock = {
  warn: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: mock(() => loggerMock),
};
mock.module("@nexus/core/node", () => ({
  createLogger: () => loggerMock,
  logger: loggerMock,
}));

// ── Test fixtures ──

type FakeSession = {
  id: string;
  tmuxTarget: string | null;
};

function makeSessionManagerStub(sessions: Record<string, FakeSession>) {
  return {
    getById: (id: string) => sessions[id] ?? null,
  } as unknown as import("../session-manager").SessionManager;
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:7400/commands/send-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Tests ──

describe("POST /commands/send-text", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  test("valid sessionId with tmuxTarget routes to tmux send-keys", async () => {
    const { initSendTextRoute, handleSendText, resetSendTextRoute } =
      await import("./commands-send-text");

    const sm = makeSessionManagerStub({
      "cc-1234-deadbeef": {
        id: "cc-1234-deadbeef",
        tmuxTarget: "nexus:cc-1234",
      },
    });
    initSendTextRoute(sm);

    const res = await handleSendText(
      makeRequest({
        sessionId: "cc-1234-deadbeef",
        text: "ls\r",
        appendNewline: false,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tmuxTarget: string };
    expect(body.ok).toBe(true);
    expect(body.tmuxTarget).toBe("nexus:cc-1234");

    // tmux invoked with the expected args
    expect(spawnCalls.length).toBe(1);
    const call = spawnCalls[0]!;
    expect(call.command).toBe("tmux");
    expect(call.args).toEqual(["send-keys", "-t", "nexus:cc-1234", "ls\r"]);

    resetSendTextRoute();
  });

  test("unknown sessionId returns 404 and does NOT invoke tmux", async () => {
    const { initSendTextRoute, handleSendText, resetSendTextRoute } =
      await import("./commands-send-text");

    const sm = makeSessionManagerStub({}); // empty — nothing resolves
    initSendTextRoute(sm);

    const res = await handleSendText(
      makeRequest({
        sessionId: "does-not-exist",
        text: "echo hi\r",
      }),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("session not found");

    // Critical: NO tmux invocation
    expect(spawnCalls.length).toBe(0);

    resetSendTextRoute();
  });

  test("empty text body returns 400 and does NOT invoke tmux", async () => {
    const { initSendTextRoute, handleSendText, resetSendTextRoute } =
      await import("./commands-send-text");

    const sm = makeSessionManagerStub({
      "cc-1234-deadbeef": {
        id: "cc-1234-deadbeef",
        tmuxTarget: "nexus:cc-1234",
      },
    });
    initSendTextRoute(sm);

    // Missing `text` field entirely — fails the isSendTextBody type guard.
    const res = await handleSendText(
      makeRequest({ sessionId: "cc-1234-deadbeef" }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("expected");

    // Critical: NO tmux invocation
    expect(spawnCalls.length).toBe(0);

    resetSendTextRoute();
  });
});
