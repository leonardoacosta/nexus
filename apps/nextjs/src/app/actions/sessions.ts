"use server";

import type { Session } from "@nexus/core";
import { narrowSessionStatus, narrowSessionType } from "@nexus/core";
import { sessions as sessionsTable, projects, agents, healthSnapshots, and, eq, desc, sql, isNull } from "@nexus/db";
import { getReadOnlyDb } from "@/lib/db";
import { getClient } from "@/lib/get-client";
import type { WithAgent } from "@/lib/agent-client";

export interface SessionsResult {
  sessions: WithAgent<Session>[];
  /** Number of enabled agents configured (regardless of online state). */
  agentCount: number;
  /**
   * Number of enabled agents considered online — i.e. either agents.lastSeen
   * or their latest health snapshot is newer than ONLINE_THRESHOLD_MS (90s).
   * Used by the dashboard to render an "all agents offline" banner when
   * agentCount > 0 && onlineAgentCount === 0.
   */
  onlineAgentCount: number;
}

export interface FetchSessionsOptions {
  /**
   * When true, only return rows that have at least one CC-fingerprint
   * discriminator populated: `pid > 0`, `tmuxTarget != ""`, `ccSessionId != ""`,
   * or `cwd != ""`. Mirrors the agent's `GET /sessions?withFingerprint=true`
   * contract (see `fix-agent-cc-session-tracking` / session-persistence spec).
   *
   * Default `false` for backward compatibility — existing callers see the
   * pre-spec behaviour (all rows, including telemetry stubs).
   */
  withFingerprint?: boolean;
}

/** Threshold (ms) — agents with a snapshot/lastSeen newer than this are considered online. */
const ONLINE_THRESHOLD_MS = 90_000;

/**
 * Fetch all sessions from the database.
 * Returns sessions sorted: active first, then by last activity descending.
 *
 * Pass `{ withFingerprint: true }` from list/poll views (dashboard root,
 * project detail) to filter out the ~thousands of telemetry stub rows that
 * the agent used to synthesize before the session-tracking fix. Detail
 * pages MAY omit the flag to keep historical stub rows reachable by direct
 * link.
 */
export async function fetchSessions(
  options: FetchSessionsOptions = {},
): Promise<SessionsResult> {
  const { withFingerprint = false } = options;
  const db = getReadOnlyDb();

  // CC-fingerprint filter — pushed to the DB level so the wire payload
  // doesn't carry stub rows. Matches the spec's "real session" predicate:
  //   pid > 0 OR tmuxTarget != "" OR ccSessionId != "" OR cwd != ""
  // In Postgres, NULL comparisons evaluate to NULL (falsy in WHERE), so
  // `pid > 0` naturally excludes NULL pid rows — same for the != '' clauses.
  const fingerprintFilter = withFingerprint
    ? sql`(
        ${sessionsTable.pid} > 0
        OR ${sessionsTable.tmuxTarget} != ''
        OR ${sessionsTable.ccSessionId} != ''
        OR ${sessionsTable.cwd} != ''
      )`
    : undefined;

  const [rows, agentRows, snapshotRows] = await Promise.all([
    db
      .select({
        id: sessionsTable.id,
        projectId: sessionsTable.projectId,
        projectName: projects.name,
        machine: sessionsTable.machine,
        status: sessionsTable.status,
        startedAt: sessionsTable.startedAt,
        lastActivity: sessionsTable.lastActivity,
        endedAt: sessionsTable.endedAt,
        pid: sessionsTable.pid,
        cwd: sessionsTable.cwd,
        branch: sessionsTable.branch,
        sessionType: sessionsTable.sessionType,
        model: sessionsTable.model,
        rateLimitUtilization: sessionsTable.rateLimitUtilization,
        totalCostUsd: sessionsTable.totalCostUsd,
        rateLimitResetAt: sessionsTable.rateLimitResetAt,
        idleSince: sessionsTable.idleSince,
        ccSessionId: sessionsTable.ccSessionId,
        tmuxSession: sessionsTable.tmuxSession,
        tmuxTarget: sessionsTable.tmuxTarget,
        spec: sessionsTable.spec,
      })
      .from(sessionsTable)
      .leftJoin(projects, eq(sessionsTable.projectId, projects.id))
      .where(fingerprintFilter)
      .orderBy(desc(sessionsTable.lastActivity)),
    db
      .select({ id: agents.id, lastSeen: agents.lastSeen })
      .from(agents)
      .where(and(eq(agents.enabled, true), isNull(agents.deletedAt))),
    db
      .select({
        agentId: healthSnapshots.agentId,
        maxTimestamp: sql<Date>`max(${healthSnapshots.timestamp})`.as("max_ts"),
      })
      .from(healthSnapshots)
      .groupBy(healthSnapshots.agentId),
  ]);

  // Map DB rows to the WithAgent<Session> shape consumers expect.
  //
  // Null-handling decisions (per design.md §Key/value mismatches):
  //   cwd         — DB nullable → fallback to "" (non-null domain)
  //   pid         — DB nullable → fallback to 0  (non-null domain)
  //   lastHeartbeat — renamed from lastActivity (DB column)
  //
  // Enum-drift narrowing (no `as` casts):
  //   status      — narrowSessionStatus() throws on unknown string value
  //   sessionType — narrowSessionType() defaults null → "ad_hoc", throws on unknown
  const mapped: WithAgent<Session>[] = rows.map((row) => ({
    id: row.id,
    // DB: number | null → domain: number. Fallback to 0 for sessions without pid.
    pid: row.pid ?? 0,
    project: row.projectName ?? null,
    projectId: row.projectId,
    machine: row.machine,
    // DB: string | null → domain: string. Fallback to "" for sessions without cwd.
    cwd: row.cwd ?? "",
    branch: row.branch ?? null,
    startedAt: row.startedAt,
    // Rename: DB lastActivity → domain lastHeartbeat
    lastHeartbeat: row.lastActivity,
    endedAt: row.endedAt ?? null,
    // Runtime narrowing — throws early on unknown enum value instead of silent bad data.
    status: narrowSessionStatus(row.status, "ended"),
    spec: row.spec ?? null,
    command: null,
    agent: row.machine,
    tmuxSession: row.tmuxSession ?? null,
    ccSessionId: row.ccSessionId ?? null,
    tmuxTarget: row.tmuxTarget ?? null,
    rateLimitUtilization: row.rateLimitUtilization ?? null,
    rateLimitType: null,
    totalCostUsd: row.totalCostUsd ?? null,
    model: row.model ?? null,
    credentialId: null,
    credentialFingerprint: null,
    // Runtime narrowing — null DB value defaults to "ad_hoc".
    sessionType: narrowSessionType(row.sessionType),
  }));

  // Sort: active first, then by lastHeartbeat descending
  const sorted = [...mapped].sort((a, b) => {
    const statusOrder: Record<string, number> = {
      active: 0,
      idle: 1,
      stale: 2,
      errored: 3,
      ended: 4,
    };
    const aOrder = statusOrder[a.status] ?? 5;
    const bOrder = statusOrder[b.status] ?? 5;

    if (aOrder !== bOrder) return aOrder - bOrder;

    // Same status — sort by last heartbeat, most recent first
    return b.lastHeartbeat.getTime() - a.lastHeartbeat.getTime();
  });

  // Compute online agent count — consider an agent online if either
  // agents.lastSeen or its latest health snapshot is within the freshness
  // window. Matches the 90s threshold used by fetchHealth().
  const now = Date.now();
  const latestSnapshotByAgent = new Map<string, Date>();
  for (const row of snapshotRows) {
    if (row.maxTimestamp) {
      latestSnapshotByAgent.set(row.agentId, new Date(row.maxTimestamp));
    }
  }

  let onlineAgentCount = 0;
  for (const agent of agentRows) {
    const snapshotTs = latestSnapshotByAgent.get(agent.id);
    const freshest = [snapshotTs, agent.lastSeen ?? null]
      .filter((d): d is Date => d != null)
      .reduce<Date | null>(
        (acc, d) => (acc == null || d.getTime() > acc.getTime() ? d : acc),
        null,
      );
    if (freshest != null && now - freshest.getTime() < ONLINE_THRESHOLD_MS) {
      onlineAgentCount++;
    }
  }

  return {
    sessions: sorted,
    agentCount: agentRows.length,
    onlineAgentCount,
  };
}

/**
 * Start a new Claude Code session on a specific agent for a given project.
 * Calls POST /session/start on the target agent.
 */
export async function startSession(
  agentName: string,
  project: string,
  path: string,
): Promise<{ sessionName: string; started: boolean; error?: string }> {
  try {
    const client = await getClient();
    const result = await client.startSession(agentName, { project, path });
    return { sessionName: result.session_name, started: result.started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { sessionName: "", started: false, error: message };
  }
}
