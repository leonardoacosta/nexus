#!/usr/bin/env bun
/**
 * One-shot backfill: populate `sessions.parent_session_id` + `child_role` from
 * historical `session_events` rows where `event_type='agent_spawn'`.
 *
 * Strategy:
 *   1. Select every agent_spawn event row.
 *   2. Parse metadata JSON; pull `parent_agent` + `child_role`.
 *   3. UPDATE the spawning session row (event's session_id) with both fields.
 *
 * Idempotent: re-running overwrites the same values. Skips rows that have
 * already been backfilled (both columns set).
 *
 * Usage:
 *   POSTGRES_URL=... bun run apps/agent/src/scripts/backfill-subagent-tree.ts
 *
 * Spec: openspec/changes/add-subagent-tree-columns (task 1.4)
 */

import { createDb, scriptErrors, sessionEvents, sessions } from "@nexus/db";
import { eq, and, isNull } from "drizzle-orm";
import {
  attachScriptErrorSink,
  createLogger,
  withErrorCapture,
} from "@nexus/core/node";

const log = createLogger("backfill-subagent-tree");

interface AgentSpawnMetadata {
  parent_agent?: string;
  child_role?: string;
  agent_name?: string;
  agent_type?: string;
}

await withErrorCapture("backfill-subagent-tree", async () => {
  const dbUrl = process.env.POSTGRES_URL;
  if (!dbUrl) {
    throw new Error("POSTGRES_URL is required");
  }

  const { db } = createDb(dbUrl);
  attachScriptErrorSink({
    async insert(records) {
      await db.insert(scriptErrors).values(
        records.map((r) => ({
          id: r.id,
          scriptName: r.scriptName,
          level: r.level,
          message: r.message,
          stack: r.stack,
          context: r.context,
          machine: r.machine,
          exitCode: r.exitCode,
          createdAt: r.createdAt,
        })),
      );
    },
  });

  const rows = await db
    .select({
      sessionId: sessionEvents.sessionId,
      metadata: sessionEvents.metadata,
      timestamp: sessionEvents.timestamp,
    })
    .from(sessionEvents)
    .where(eq(sessionEvents.eventType, "agent_spawn"));

  log.info({ count: rows.length }, "backfill: agent_spawn events to process");

  let updated = 0;
  let skipped = 0;
  let parseErrors = 0;

  // Deduplicate by sessionId — when a session spawned multiple agents
  // we use the FIRST (oldest) spawn event so the parent linkage is
  // anchored to the original parent.
  const bySession = new Map<string, AgentSpawnMetadata>();
  const sortedRows = [...rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  for (const row of sortedRows) {
    if (!row.metadata) {
      skipped++;
      continue;
    }
    let parsed: AgentSpawnMetadata;
    try {
      parsed = JSON.parse(row.metadata) as AgentSpawnMetadata;
    } catch {
      parseErrors++;
      continue;
    }
    if (!bySession.has(row.sessionId)) {
      bySession.set(row.sessionId, parsed);
    }
  }

  for (const [sessionId, meta] of bySession) {
    const parent = meta.parent_agent;
    const role = meta.child_role;
    if (!parent && !role) {
      skipped++;
      continue;
    }
    // Only touch rows that aren't already filled in (idempotent).
    const update: { parentSessionId?: string; childRole?: string } = {};
    if (parent) update.parentSessionId = parent;
    if (role) update.childRole = role;
    await db
      .update(sessions)
      .set(update)
      .where(
        and(
          eq(sessions.id, sessionId),
          // Only update if at least one target column is currently null.
          // This makes re-runs cheap and avoids touching rows already
          // populated by the live hook handler.
          isNull(sessions.parentSessionId),
        ),
      );
    updated++;
  }

  log.info(
    { scanned: rows.length, updated, skipped, parseErrors },
    "backfill complete",
  );
});
