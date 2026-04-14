"use server";

import type { HealthMetrics } from "@nexus/core";
import { healthSnapshots, agents, eq, desc, sql } from "@nexus/db";
import { getDb } from "@/lib/db";
import type { WithAgent, AgentStatus } from "@/lib/agent-client";

export interface HealthResult {
  metrics: WithAgent<HealthMetrics>[];
  statuses: AgentStatus[];
}

/** Threshold (ms) — agents with a snapshot newer than this are considered online. */
const ONLINE_THRESHOLD_MS = 90_000; // 3x the 30s health-scheduler interval

/**
 * Fetch latest health snapshots from the database.
 * Returns per-machine health data plus agent online/offline statuses
 * derived from snapshot freshness.
 */
export async function fetchHealth(): Promise<HealthResult> {
  const db = getDb();

  // Subquery: latest snapshot id per agent
  const latestPerAgent = db
    .select({
      agentId: healthSnapshots.agentId,
      maxId: sql<number>`max(${healthSnapshots.id})`.as("max_id"),
    })
    .from(healthSnapshots)
    .groupBy(healthSnapshots.agentId)
    .as("latest");

  const [snapshotRows, agentRows] = await Promise.all([
    db
      .select({
        id: healthSnapshots.id,
        agentId: healthSnapshots.agentId,
        timestamp: healthSnapshots.timestamp,
        cpuPercent: healthSnapshots.cpuPercent,
        ramPercent: healthSnapshots.ramPercent,
        diskPercent: healthSnapshots.diskPercent,
        dockerContainers: healthSnapshots.dockerContainers,
        rawJson: healthSnapshots.rawJson,
      })
      .from(healthSnapshots)
      .innerJoin(
        latestPerAgent,
        sql`${healthSnapshots.agentId} = ${latestPerAgent.agentId} AND ${healthSnapshots.id} = ${latestPerAgent.maxId}`,
      )
      .orderBy(desc(healthSnapshots.timestamp)),
    db
      .select({
        id: agents.id,
        name: agents.name,
        lastSeen: agents.lastSeen,
      })
      .from(agents)
      .where(eq(agents.enabled, true)),
  ]);

  const now = Date.now();

  // Build a map of agentId -> latest snapshot timestamp for status derivation
  const snapshotTimestamps = new Map<string, Date>();
  for (const row of snapshotRows) {
    snapshotTimestamps.set(row.agentId, row.timestamp);
  }

  // Parse rawJson where available; fall back to a minimal HealthMetrics from columns
  const metrics: WithAgent<HealthMetrics>[] = snapshotRows
    .map((row) => {
      if (row.rawJson) {
        try {
          const parsed = JSON.parse(row.rawJson) as HealthMetrics;
          return { ...parsed, agent: row.agentId };
        } catch {
          // Fall through to column-based fallback
        }
      }

      // Minimal fallback when rawJson is missing/corrupt
      return {
        hostname: row.agentId,
        uptime_seconds: 0,
        cpu: { overall_percent: row.cpuPercent ?? 0, per_core_percent: [], load_average: [] },
        ram: { total_bytes: 0, used_bytes: 0, percent: row.ramPercent ?? 0 },
        disk: row.diskPercent != null
          ? [{ mount: "/", total_bytes: 0, used_bytes: 0, percent: row.diskPercent }]
          : [],
        docker: row.dockerContainers != null
          ? { containers: row.dockerContainers, running: 0 }
          : null,
        agent: row.agentId,
      };
    });

  // Derive agent statuses from DB data
  const statuses: AgentStatus[] = agentRows.map((agent) => {
    const snapshotTs = snapshotTimestamps.get(agent.id);
    const lastSeen = snapshotTs ?? agent.lastSeen ?? null;
    const online = lastSeen != null && now - lastSeen.getTime() < ONLINE_THRESHOLD_MS;

    return {
      name: agent.name || agent.id,
      online,
      lastSeen,
    };
  });

  return { metrics, statuses };
}
