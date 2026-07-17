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

import { describe, test, expect, mock, spyOn, beforeEach, afterAll } from "bun:test";
import type { Db } from "@nexus/db";
import type { SessionManager } from "../session-manager";
import type { WatcherEvent, Session } from "@nexus/core";
import * as schemaDriftNs from "./schema-drift";
// nx-06o3m/nx-rzaej: hold the REAL barrels so the git-project + db/sessions
// mocks below are RESTORABLE spies, not process-global strip-style
// `mock.module` factories. The prior `mock.module("../db/sessions", () => ({…}))`
// listed only 5 exports and NEVER spread the real module, so it STRIPPED
// `upsertSession` (and every other export) for the WHOLE process — later files
// that import it (process-watcher.ts, socket-server/dispatcher.ts) then died
// with `Export named 'upsertSession' not found`. spyOn keeps every real export
// present and reverts in afterAll.
import * as gitProjectNs from "./git-project";
import * as sessionsNs from "../db/sessions";
// nx-qayeb.1: the 1c context-usage step reads the transcript via
// `collectContextUsage` and writes into the session-context store via
// `applyStatuslineSnapshot`. Spy both as RESTORABLE namespace spies (same
// pattern as the sessions writers above) so the step is observable without
// touching the filesystem or the real store, and both revert in afterAll.
import * as ctxCollectorNs from "./context-usage-collector";
import * as sessionContextNs from "../routes/session-context";

// ─── Module mocks (must register before importing helper) ──────────────────

// nx-jlx1c: spy `inspectAndEmitDrift` via RESTORABLE `spyOn` rather than
// process-global, irreversible `mock.module`. A raw mock.module here replaced
// the real function for the WHOLE run, so schema-drift.test.ts (loads later)
// saw this no-op stub and its emit assertions observed 0 events. `spyOn` +
// `mockRestore()` in afterAll reverts the real function for that sibling suite.
const inspectAndEmitDriftMock = spyOn(
  schemaDriftNs,
  "inspectAndEmitDrift",
).mockImplementation(async (_db: Db, _evt: string, _payload: unknown) => {});
afterAll(() => {
  inspectAndEmitDriftMock.mockRestore();
});

const resolveGitOriginMock = mock(async (_cwd: string | null | undefined) => null as
  | { provider: string; ownerRepo: string }
  | null);
// nx-06o3m/nx-rzaej: restorable spy — every other git-project export stays REAL
// and present, and resolveGitOrigin reverts in afterAll for sibling suites.
const resolveGitOriginSpy = spyOn(gitProjectNs, "resolveGitOrigin").mockImplementation(
  resolveGitOriginMock as unknown as typeof gitProjectNs.resolveGitOrigin,
);

const updateSessionGitOriginMock = mock(
  async (_db: Db, _id: string, _origin: { provider: string; ownerRepo: string }) => {},
);
// nx-cvyxt: the helper backfills empty-cwd rows via backfillSessionCwd.
// Default mock returns 1 (one row touched); individual tests override it.
const backfillSessionCwdMock = mock(
  async (_db: Db, _id: string, _cwd: string) => 1 as number,
);
// session-enrichment: the helper now also derives + persists agentState on
// every event. Mock the persist writer and provide a faithful inline
// `deriveAgentState` (mirrors the real pure mapping in ../db/sessions) so the
// mocked module is self-contained — re-importing the real module here would
// recurse through this same mock.
const updateSessionAgentStateMock = mock(
  async (_db: Db, _id: string, _state: string) => 1 as number,
);
// add-session-model-authority: the helper persists the raw model on
// session_start. Mock the write-through so the call is observable without a DB.
const updateSessionModelMock = mock(
  async (_db: Db, _id: string, _model: string) => 1 as number,
);
// nx-06o3m/nx-rzaej: spy ONLY the four write-through helpers the SUT exercises.
// `deriveAgentState` (and `upsertSession` + every other export) stay REAL and
// present — the SUT's real `deriveAgentState` mapping is used directly, so no
// inline re-implementation is needed. All spies revert in afterAll, so later
// files that import `upsertSession` etc. get the untouched module back.
const sessionsSpies = [
  spyOn(sessionsNs, "updateSessionGitOrigin").mockImplementation(
    updateSessionGitOriginMock as unknown as typeof sessionsNs.updateSessionGitOrigin,
  ),
  spyOn(sessionsNs, "backfillSessionCwd").mockImplementation(
    backfillSessionCwdMock as unknown as typeof sessionsNs.backfillSessionCwd,
  ),
  spyOn(sessionsNs, "updateSessionAgentState").mockImplementation(
    updateSessionAgentStateMock as unknown as typeof sessionsNs.updateSessionAgentState,
  ),
  spyOn(sessionsNs, "updateSessionModel").mockImplementation(
    updateSessionModelMock as unknown as typeof sessionsNs.updateSessionModel,
  ),
];
// nx-qayeb.1: 1c context-usage collection spies. `collectContextUsage`
// defaults to null (no-op) so pre-existing tests — whose payloads carry no
// `transcript_path` — never trigger a snapshot write. Individual tests below
// override the return.
const collectContextUsageMock = mock(
  (_path: string) => null as { usedPercentage: number; contextWindowSize: number } | null,
);
const collectContextUsageSpy = spyOn(ctxCollectorNs, "collectContextUsage").mockImplementation(
  collectContextUsageMock as unknown as typeof ctxCollectorNs.collectContextUsage,
);
const applyStatuslineSnapshotMock = mock(
  (_id: string, _pct: number, _size: number | null) => {},
);
const applyStatuslineSnapshotSpy = spyOn(
  sessionContextNs,
  "applyStatuslineSnapshot",
).mockImplementation(
  applyStatuslineSnapshotMock as unknown as typeof sessionContextNs.applyStatuslineSnapshot,
);

afterAll(() => {
  resolveGitOriginSpy.mockRestore();
  for (const spy of sessionsSpies) spy.mockRestore();
  collectContextUsageSpy.mockRestore();
  applyStatuslineSnapshotSpy.mockRestore();
});

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
    updateSessionAgentStateMock.mockClear();
    updateSessionAgentStateMock.mockImplementation(async () => 1);
    updateSessionModelMock.mockClear();
    updateSessionModelMock.mockImplementation(async () => 1);
    collectContextUsageMock.mockClear();
    collectContextUsageMock.mockImplementation(() => null);
    applyStatuslineSnapshotMock.mockClear();
    applyStatuslineSnapshotMock.mockImplementation(() => {});
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

  test("session_start persists the raw model from the payload (add-session-model-authority)", async () => {
    resolveGitOriginMock.mockImplementation(async () => null);
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "sess-model",
        payload: { session_id: "sess-model", cwd: "/x", model: "claude-opus-4-8" },
        source: "socket",
        cwd: "/x",
      },
      { sessionManager: sm, db: fakeDb },
    );
    expect(updateSessionModelMock).toHaveBeenCalledTimes(1);
    expect(updateSessionModelMock).toHaveBeenCalledWith(
      fakeDb,
      "sess-model",
      "claude-opus-4-8",
    );
  });

  test("session_start with no model does NOT call updateSessionModel (no-clobber)", async () => {
    resolveGitOriginMock.mockImplementation(async () => null);
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "sess-no-model",
        payload: { session_id: "sess-no-model", cwd: "/x" },
        source: "socket",
        cwd: "/x",
      },
      { sessionManager: sm, db: fakeDb },
    );
    expect(updateSessionModelMock).not.toHaveBeenCalled();
  });

  test("session_start persists model even when the hook carries no cwd", async () => {
    // Model persistence is independent of the git-origin (cwd) branch: a
    // cwd-less session_start still carries a model and must persist it.
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "sess-model-nocwd",
        payload: { session_id: "sess-model-nocwd", model: "claude-sonnet-4-6" },
        source: "socket",
        cwd: null,
      },
      { sessionManager: sm, db: fakeDb },
    );
    expect(updateSessionModelMock).toHaveBeenCalledWith(
      fakeDb,
      "sess-model-nocwd",
      "claude-sonnet-4-6",
    );
    // The cwd-dependent git-origin branch was skipped (no cwd).
    expect(updateSessionGitOriginMock).not.toHaveBeenCalled();
  });

  test("session_start model persist failure is non-fatal (helper still resolves ok)", async () => {
    updateSessionModelMock.mockImplementation(async () => {
      throw new Error("UPDATE failed");
    });
    resolveGitOriginMock.mockImplementation(async () => null);
    const sm = createMockSessionManager();
    const result = await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "sess-model-throws",
        payload: { session_id: "sess-model-throws", cwd: "/x", model: "claude-opus-4-8" },
        source: "socket",
        cwd: "/x",
      },
      { sessionManager: sm, db: fakeDb },
    );
    expect(updateSessionModelMock).toHaveBeenCalled();
    // Swallowed in its own try/catch — enrichmentOk stays true.
    expect(result.enrichmentOk).toBe(true);
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

  test("persists agentState=blocked for a session_heartbeat (tool turn)", async () => {
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "session_heartbeat",
        sessionId: "sess-blocked",
        payload: {},
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );
    expect(updateSessionAgentStateMock).toHaveBeenCalledTimes(1);
    expect(updateSessionAgentStateMock).toHaveBeenCalledWith(
      fakeDb,
      "sess-blocked",
      "blocked",
    );
  });

  test("persists agentState=waiting for a notification hook", async () => {
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "notification",
        sessionId: "sess-waiting",
        payload: { message: "permission?" },
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );
    expect(updateSessionAgentStateMock).toHaveBeenCalledWith(
      fakeDb,
      "sess-waiting",
      "waiting",
    );
  });

  test("persists agentState=ready for a session_stop hook", async () => {
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "session_stop",
        sessionId: "sess-ready",
        payload: {},
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );
    expect(updateSessionAgentStateMock).toHaveBeenCalledWith(
      fakeDb,
      "sess-ready",
      "ready",
    );
  });

  test("does NOT persist agentState for a non-signal event (session_start)", async () => {
    resolveGitOriginMock.mockImplementation(async () => null);
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "session_start",
        sessionId: "sess-start",
        payload: {},
        source: "socket",
        cwd: "/x",
      },
      { sessionManager: sm, db: fakeDb },
    );
    expect(updateSessionAgentStateMock).not.toHaveBeenCalled();
  });

  test("skips agentState persist when no sessionId is present", async () => {
    const sm = createMockSessionManager();
    await processHookEvent(
      { eventType: "session_stop", payload: {}, source: "socket" },
      { sessionManager: sm, db: fakeDb },
    );
    expect(updateSessionAgentStateMock).not.toHaveBeenCalled();
  });

  test("agentState persist failure is non-fatal (helper still resolves)", async () => {
    updateSessionAgentStateMock.mockImplementation(async () => {
      throw new Error("UPDATE failed");
    });
    const sm = createMockSessionManager();
    const result = await processHookEvent(
      {
        eventType: "session_stop",
        sessionId: "sess-throws",
        payload: {},
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );
    // The throw is swallowed; agentState is a distinct concern from
    // enrichmentOk, which stays true (the per-event switch did not fail).
    expect(updateSessionAgentStateMock).toHaveBeenCalled();
    expect(result.enrichmentOk).toBe(true);
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

  // ── 1c. Context-usage collection (nx-qayeb.1) ──────────────────────────────

  test("collects context usage and writes the snapshot when the payload carries transcript_path", async () => {
    collectContextUsageMock.mockImplementation(() => ({
      usedPercentage: 42,
      contextWindowSize: 200000,
    }));
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "PreToolUse",
        sessionId: "sess-ctx",
        payload: { tool_name: "Read", transcript_path: "/x/transcript.jsonl" },
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );

    expect(collectContextUsageMock).toHaveBeenCalledTimes(1);
    expect(collectContextUsageMock).toHaveBeenCalledWith("/x/transcript.jsonl");
    expect(applyStatuslineSnapshotMock).toHaveBeenCalledTimes(1);
    expect(applyStatuslineSnapshotMock).toHaveBeenCalledWith(
      "sess-ctx",
      42,
      200000,
    );
  });

  test("does NOT write a snapshot when the collector returns null (no usable transcript line)", async () => {
    collectContextUsageMock.mockImplementation(() => null);
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "PreToolUse",
        sessionId: "sess-null-ctx",
        payload: { transcript_path: "/x/empty.jsonl" },
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );

    expect(collectContextUsageMock).toHaveBeenCalledWith("/x/empty.jsonl");
    expect(applyStatuslineSnapshotMock).not.toHaveBeenCalled();
  });

  test("skips context-usage collection when the payload has no transcript_path", async () => {
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "PreToolUse",
        sessionId: "sess-no-transcript",
        payload: { tool_name: "Read" },
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );

    expect(collectContextUsageMock).not.toHaveBeenCalled();
    expect(applyStatuslineSnapshotMock).not.toHaveBeenCalled();
  });

  test("runs context-usage collection even without a DB (no db dependency)", async () => {
    collectContextUsageMock.mockImplementation(() => ({
      usedPercentage: 10,
      contextWindowSize: 200000,
    }));
    const sm = createMockSessionManager();
    await processHookEvent(
      {
        eventType: "PostToolUse",
        sessionId: "sess-nodb-ctx",
        payload: { transcript_path: "/x/t.jsonl" },
        source: "socket",
      },
      { sessionManager: sm, db: null },
    );

    expect(applyStatuslineSnapshotMock).toHaveBeenCalledWith(
      "sess-nodb-ctx",
      10,
      200000,
    );
  });

  test("context-usage collection failure is non-fatal (helper still resolves, enrichmentOk stays true)", async () => {
    collectContextUsageMock.mockImplementation(() => {
      throw new Error("read blew up");
    });
    const sm = createMockSessionManager();
    const result = await processHookEvent(
      {
        eventType: "PreToolUse",
        sessionId: "sess-ctx-throws",
        payload: { transcript_path: "/x/t.jsonl" },
        source: "socket",
      },
      { sessionManager: sm, db: fakeDb },
    );

    expect(collectContextUsageMock).toHaveBeenCalled();
    // Swallowed in its own try/catch — a distinct concern from enrichmentOk.
    expect(result.enrichmentOk).toBe(true);
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
