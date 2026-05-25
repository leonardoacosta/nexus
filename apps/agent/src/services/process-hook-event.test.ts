/**
 * Unit tests for the shared hook event processor.
 *
 * Asserts that:
 *   - schema-drift runs first on every event (even unknown ones)
 *   - `session_start` triggers git origin resolution + persistence when a
 *     cwd points at a git repo
 *   - `agent_spawn` populates parent_session_id + child_role via
 *     `SessionManager.updateLinkage` and accepts both `parent_session_id`
 *     (canonical) and `parent_agent` (back-compat)
 *   - failures in any enrichment branch are swallowed (helper never throws)
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Db } from "@nexus/db";
import type { SessionManager } from "../session-manager";
import type { WatcherEvent, Session } from "@nexus/core";

// ─── Module mocks (must register before importing helper) ──────────────────

const inspectAndEmitDriftMock = mock(async (_db: Db, _evt: string, _payload: unknown) => {});
mock.module("./schema-drift", () => ({
  inspectAndEmitDrift: inspectAndEmitDriftMock,
}));

const resolveGitOriginMock = mock(async (_cwd: string | null | undefined) => null as
  | { provider: string; ownerRepo: string }
  | null);
mock.module("./git-project", () => ({
  resolveGitOrigin: resolveGitOriginMock,
}));

const updateSessionGitOriginMock = mock(
  async (_db: Db, _id: string, _origin: { provider: string; ownerRepo: string }) => {},
);
// nx-cvyxt: the helper backfills empty-cwd rows via backfillSessionCwd.
// Default mock returns 1 (one row touched); individual tests override it.
const backfillSessionCwdMock = mock(
  async (_db: Db, _id: string, _cwd: string) => 1 as number,
);
mock.module("../db/sessions", () => ({
  updateSessionGitOrigin: updateSessionGitOriginMock,
  backfillSessionCwd: backfillSessionCwdMock,
}));

// ─── Mock SessionManager ───────────────────────────────────────────────────

interface RecordedLinkage {
  sessionId: string;
  parentSessionId?: string | null;
  childRole?: string | null;
}

function createMockSessionManager(): SessionManager & {
  linkageUpdates: RecordedLinkage[];
  patches: Array<{ id: string; patch: Partial<Session> }>;
} {
  const linkageUpdates: RecordedLinkage[] = [];
  const patches: Array<{ id: string; patch: Partial<Session> }> = [];
  return {
    linkageUpdates,
    patches,
    handleWatcherEvent: (_e: WatcherEvent) => {},
    getAll: () => [],
    getActive: () => [],
    getById: () => null,
    sweepIdle: () => {},
    stop: () => {},
    init: async () => {},
    updateLinkage: (sessionId, linkage) => {
      linkageUpdates.push({ sessionId, ...linkage });
    },
    patch: (id, patch) => {
      patches.push({ id, patch });
    },
  };
}

const fakeDb = {} as unknown as Db;

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("processHookEvent", () => {
  let processHookEvent: typeof import("./process-hook-event").processHookEvent;

  beforeEach(async () => {
    inspectAndEmitDriftMock.mockClear();
    resolveGitOriginMock.mockClear();
    updateSessionGitOriginMock.mockClear();
    backfillSessionCwdMock.mockClear();
    backfillSessionCwdMock.mockImplementation(async () => 1);
    ({ processHookEvent } = await import("./process-hook-event"));
  });

  test("schema-drift runs first on every event, including unknown types", async () => {
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "PreToolUse",
        sessionId: "s1",
        payload: { tool_name: "Read", file_path: "/x" },
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );

    expect(inspectAndEmitDriftMock).toHaveBeenCalledTimes(1);
    expect(inspectAndEmitDriftMock).toHaveBeenCalledWith(
      fakeDb,
      "PreToolUse",
      expect.objectContaining({ tool_name: "Read" }),
    );
  });

  test("skips schema-drift when db is null", async () => {
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "session_heartbeat",
        sessionId: "s1",
        payload: {},
        source: "socket",
      },
      { sessionManager: sm, db: null },
    );

    expect(inspectAndEmitDriftMock).not.toHaveBeenCalled();
  });

  test("session_start resolves git origin and persists when cwd is a git repo", async () => {
    resolveGitOriginMock.mockImplementation(async () => ({
      provider: "github.com",
      ownerRepo: "leonardoacosta/nexus",
    }));

    const sm = createMockSessionManager();
    const result = await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "sess-git",
        payload: { session_id: "sess-git", cwd: "/Users/x/dev/nx" },
        source: "socket",
        cwd: "/Users/x/dev/nx",
      },
      { sessionManager: sm, db: fakeDb },
    );

    expect(resolveGitOriginMock).toHaveBeenCalledWith("/Users/x/dev/nx");
    expect(updateSessionGitOriginMock).toHaveBeenCalledWith(fakeDb, "sess-git", {
      provider: "github.com",
      ownerRepo: "leonardoacosta/nexus",
    });
    expect(result.driftOk).toBe(true);
    expect(result.enrichmentOk).toBe(true);
  });

  test("session_start backfills the row cwd from the hook payload (nx-cvyxt)", async () => {
    resolveGitOriginMock.mockImplementation(async () => null);

    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "sess-empty-cwd",
        payload: { session_id: "sess-empty-cwd", cwd: "/Users/x/dev/nx" },
        source: "socket",
        cwd: "/Users/x/dev/nx",
      },
      { sessionManager: sm, db: fakeDb },
    );

    // The hook-supplied cwd is forwarded to the idempotent backfill writer.
    expect(backfillSessionCwdMock).toHaveBeenCalledTimes(1);
    expect(backfillSessionCwdMock).toHaveBeenCalledWith(
      fakeDb,
      "sess-empty-cwd",
      "/Users/x/dev/nx",
    );
  });

  test("session_start skips cwd backfill when the hook carries no cwd", async () => {
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "sess-no-cwd",
        payload: { session_id: "sess-no-cwd" },
        source: "socket",
        cwd: null,
      },
      { sessionManager: sm, db: fakeDb },
    );

    // The early `!input.cwd` guard means we never attempt a backfill.
    expect(backfillSessionCwdMock).not.toHaveBeenCalled();
  });

  test("session_start cwd backfill failure is non-fatal; git origin still resolves", async () => {
    backfillSessionCwdMock.mockImplementation(async () => {
      throw new Error("UPDATE failed");
    });
    resolveGitOriginMock.mockImplementation(async () => ({
      provider: "github.com",
      ownerRepo: "leonardoacosta/nexus",
    }));

    const sm = createMockSessionManager();
    const result = await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "sess-backfill-throws",
        payload: { session_id: "sess-backfill-throws", cwd: "/x" },
        source: "socket",
        cwd: "/x",
      },
      { sessionManager: sm, db: fakeDb },
    );

    // Backfill threw but was swallowed — git-origin resolution still ran and
    // the helper reports the branch as successful.
    expect(backfillSessionCwdMock).toHaveBeenCalled();
    expect(updateSessionGitOriginMock).toHaveBeenCalledWith(fakeDb, "sess-backfill-throws", {
      provider: "github.com",
      ownerRepo: "leonardoacosta/nexus",
    });
    expect(result.enrichmentOk).toBe(true);
  });

  test("session_start with non-git cwd does NOT call updateSessionGitOrigin", async () => {
    resolveGitOriginMock.mockImplementation(async () => null);

    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "sess-no-git",
        payload: {},
        source: "socket",
        cwd: "/tmp/no-repo",
      },
      { sessionManager: sm, db: fakeDb },
    );

    expect(resolveGitOriginMock).toHaveBeenCalled();
    expect(updateSessionGitOriginMock).not.toHaveBeenCalled();
  });

  test("agent_spawn populates parent_session_id and child_role on the in-memory session", async () => {
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "agent_spawn",
        sessionId: "child-123",
        payload: { parent_session_id: "parent-456", child_role: "task" },
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );

    expect(sm.linkageUpdates).toHaveLength(1);
    expect(sm.linkageUpdates[0]).toEqual({
      sessionId: "child-123",
      parentSessionId: "parent-456",
      childRole: "task",
    });
  });

  test("agent_spawn accepts `parent_agent` payload key for back-compat", async () => {
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "agent_spawn",
        sessionId: "child-legacy",
        payload: { parent_agent: "parent-old", child_role: "review" },
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );

    expect(sm.linkageUpdates).toHaveLength(1);
    expect(sm.linkageUpdates[0]!.parentSessionId).toBe("parent-old");
    expect(sm.linkageUpdates[0]!.childRole).toBe("review");
  });

  test("agent_spawn with no linkage payload does NOT call updateLinkage", async () => {
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "agent_spawn",
        sessionId: "child-bare",
        payload: { agent_type: "engineer" },
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );

    expect(sm.linkageUpdates).toHaveLength(0);
  });

  test("helper never throws when schema-drift inspector rejects", async () => {
    inspectAndEmitDriftMock.mockImplementation(async () => {
      throw new Error("DB down");
    });

    const sm = createMockSessionManager();
    const result = await processHookEvent(
      {
        eventType: "session_heartbeat",
        sessionId: "s1",
        payload: {},
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );

    expect(result.driftOk).toBe(false);
    expect(result.enrichmentOk).toBe(true);
  });

  test("helper never throws when git origin resolver rejects", async () => {
    inspectAndEmitDriftMock.mockImplementation(async () => {});
    resolveGitOriginMock.mockImplementation(async () => {
      throw new Error("git binary missing");
    });

    const sm = createMockSessionManager();
    const result = await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "s-err",
        payload: {},
        source: "socket",
        cwd: "/x",
      },
      { sessionManager: sm, db: fakeDb },
    );

    expect(result.driftOk).toBe(true);
    expect(result.enrichmentOk).toBe(false);
  });

  test("parity: socket vs http source labels produce identical DB writes for the same payload", async () => {
    inspectAndEmitDriftMock.mockImplementation(async () => {});
    resolveGitOriginMock.mockImplementation(async () => ({
      provider: "github.com",
      ownerRepo: "a/b",
    }));

    const sm = createMockSessionManager();
    const payload = { session_id: "sess-parity", cwd: "/x" };

    await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "sess-parity",
        payload,
        source: "socket",
        cwd: "/x",
      },
      { sessionManager: sm, db: fakeDb },
    );

    await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "sess-parity",
        payload,
        source: "http",
        cwd: "/x",
      },
      { sessionManager: sm, db: fakeDb },
    );

    // Both paths called updateSessionGitOrigin with the same args.
    expect(updateSessionGitOriginMock).toHaveBeenCalledTimes(2);
    const firstCall = updateSessionGitOriginMock.mock.calls[0];
    const secondCall = updateSessionGitOriginMock.mock.calls[1];
    expect(firstCall).toEqual(secondCall);
  });
});
