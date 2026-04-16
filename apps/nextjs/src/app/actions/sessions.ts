"use server";

import type { Session } from "@nexus/core";
import { sessions as sessionsTable, projects, agents, healthSnapshots, eq, desc, sql } from "@nexus/db";
import { getDb } from "@/lib/db";
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

/** Threshold (ms) — agents with a snapshot/lastSeen newer than this are considered online. */
const ONLINE_THRESHOLD_MS = 90_000;

/**
 * Fetch all sessions from the database.
 * Returns sessions sorted: active first, then by last activity descending.
 */
export async function fetchSessions(): Promise<SessionsResult> {
  const db = getDb();

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
      .orderBy(desc(sessionsTable.lastActivity)),
    db
      .select({ id: agents.id, lastSeen: agents.lastSeen })
      .from(agents)
      .where(eq(agents.enabled, true)),
    db
      .select({
        agentId: healthSnapshots.agentId,
        maxTimestamp: sql<Date>`max(${healthSnapshots.timestamp})`.as("max_ts"),
      })
      .from(healthSnapshots)
      .groupBy(healthSnapshots.agentId),
  ]);

  // Map DB rows to the WithAgent<Session> shape consumers expect
  const mapped: WithAgent<Session>[] = rows.map((row) => ({
    id: row.id,
    pid: row.pid ?? 0,
    project: row.projectName ?? null,
    projectId: row.projectId,
    machine: row.machine,
    cwd: row.cwd ?? "",
    branch: row.branch ?? null,
    startedAt: row.startedAt,
    lastHeartbeat: row.lastActivity,
    endedAt: row.endedAt ?? null,
    status: (row.status as Session["status"]) ?? "ended",
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
    sessionType: (row.sessionType as Session["sessionType"]) ?? "ad_hoc",
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
