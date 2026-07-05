/**
 * Tests for POST /commands/send-text.
 *
 * Spec: openspec/changes/session-attach-and-cwd-cap/specs/terminal-attach/spec.md
 *
 * Covers:
 *   1. valid sessionId with tmuxTarget → 200, tmux send-keys invoked
 *   2. unknown sessionId → 404, tmux NOT invoked
 *   3. empty/missing text → 400, tmux NOT invoked
 *   4. invalid tmuxTarget (shell-metachar) → 409, tmux NOT invoked
 *
 * The route spawns `tmux send-keys` via an injected `safeSpawn`-shaped fake
 * (see `initSendTextRoute`'s second parameter) rather than mocking
 * `@nexus/core/node` — a partial `mock.module` factory there would strip
 * `safeSpawn` for sibling suites in the same process (see
 * `apps/agent/src/testing/mock-core-node.ts:53-61`). The bun test preload
 * already silences the logger for every suite. The SessionManager is a
 * minimal stub matching the shape `handleSendText` reads.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type { safeSpawn } from "@nexus/core/node";

// ── Spawn fake — capture calls + simulate `tmux` exit 0 ──

interface SpawnCall {
  binary: string;
  args: ReadonlyArray<string>;
}
const spawnCalls: SpawnCall[] = [];

const fakeSpawn = ((binary: string, args: string[]) => {
  spawnCalls.push({ binary, args: [...args] });
  return {
    pid: 12345,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined, // route treats non-ReadableStream as ""
    exitCode: Promise.resolve(0),
    abort: async () => 0,
    kill: () => {},
  };
}) as unknown as typeof safeSpawn;

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
    initSendTextRoute(sm, fakeSpawn);

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
    expect(call.binary).toBe("tmux");
    expect(call.args).toEqual(["send-keys", "-t", "nexus:cc-1234", "ls\r"]);

    resetSendTextRoute();
  });

  test("unknown sessionId returns 404 and does NOT invoke tmux", async () => {
    const { initSendTextRoute, handleSendText, resetSendTextRoute } =
      await import("./commands-send-text");

    const sm = makeSessionManagerStub({}); // empty — nothing resolves
    initSendTextRoute(sm, fakeSpawn);

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
    initSendTextRoute(sm, fakeSpawn);

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

  test("invalid tmuxTarget (shell-metachar) returns 409 and does NOT spawn", async () => {
    const { initSendTextRoute, handleSendText, resetSendTextRoute } =
      await import("./commands-send-text");

    const sm = makeSessionManagerStub({
      "cc-evil-0000": { id: "cc-evil-0000", tmuxTarget: "bad;target" },
    });
    initSendTextRoute(sm, fakeSpawn);

    const res = await handleSendText(
      makeRequest({ sessionId: "cc-evil-0000", text: "hello" }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid tmuxTarget");

    // Critical: NO spawn of any kind
    expect(spawnCalls.length).toBe(0);

    resetSendTextRoute();
  });
});
