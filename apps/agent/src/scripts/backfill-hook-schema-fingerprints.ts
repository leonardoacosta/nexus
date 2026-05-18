#!/usr/bin/env bun
/**
 * One-shot backfill: seed `hook_schema_fingerprints` from the last 7 days of
 * `session_events.metadata`. For each event, compute the top-level-key
 * fingerprint and INSERT (or bump `last_seen` on conflict) the row.
 *
 * Idempotent: re-running the script is safe — the upsert path on the unique
 * `(event_type, fingerprint)` constraint preserves `first_seen` while
 * bumping `last_seen`.
 *
 * Usage:
 *   POSTGRES_URL=... bun run apps/agent/src/scripts/backfill-hook-schema-fingerprints.ts
 *   POSTGRES_URL=... bun run apps/agent/src/scripts/backfill-hook-schema-fingerprints.ts --days=30
 *
 * Spec: openspec/changes/add-schema-drift-detector (task 1.6)
 */

import { createDb, scriptErrors, sessionEvents, hookSchemaFingerprints } from "@nexus/db";
import { gte, sql } from "drizzle-orm";
import {
  attachScriptErrorSink,
  createLogger,
  withErrorCapture,
} from "@nexus/core/node";

import { fingerprintPayload } from "../services/schema-drift";

const log = createLogger("backfill-hook-schema-fingerprints");

await withErrorCapture("backfill-hook-schema-fingerprints", async () => {
  const dbUrl = process.env.POSTGRES_URL;
  if (!dbUrl) {
    throw new Error("POSTGRES_URL is required");
  }

  // CLI: --days=N — defaults to 7.
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = daysArg ? parseInt(daysArg.split("=")[1] ?? "7", 10) : 7;
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs);

  const db = createDb(dbUrl);
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

  log.info({ since: since.toISOString(), days }, "backfill: scanning session_events");

  const rows = await db
    .select({
      id: sessionEvents.id,
      eventType: sessionEvents.eventType,
      metadata: sessionEvents.metadata,
      timestamp: sessionEvents.timestamp,
    })
    .from(sessionEvents)
    .where(gte(sessionEvents.timestamp, since));

  log.info({ count: rows.length }, "backfill: events to process");

  // Bucket by (event_type, fingerprint) so we only INSERT once per pair.
  const seen = new Map<string, { eventType: string; fingerprint: string; firstSeen: Date; lastSeen: Date }>();

  let parseErrors = 0;
  for (const row of rows) {
    if (!row.metadata) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.metadata);
    } catch {
      parseErrors++;
      continue;
    }
    const fingerprint = fingerprintPayload(parsed);
    const key = `${row.eventType}\0${fingerprint}`;
    const existing = seen.get(key);
    if (existing) {
      if (row.timestamp < existing.firstSeen) existing.firstSeen = row.timestamp;
      if (row.timestamp > existing.lastSeen) existing.lastSeen = row.timestamp;
    } else {
      seen.set(key, {
        eventType: row.eventType,
        fingerprint,
        firstSeen: row.timestamp,
        lastSeen: row.timestamp,
      });
    }
  }

  log.info(
    { pairs: seen.size, parseErrors },
    "backfill: distinct (event_type, fingerprint) pairs computed",
  );

  // Upsert each pair. On conflict, only bump `last_seen` (preserve first_seen).
  let inserted = 0;
  for (const value of seen.values()) {
    await db
      .insert(hookSchemaFingerprints)
      .values({
        eventType: value.eventType,
        fingerprint: value.fingerprint,
        firstSeen: value.firstSeen,
        lastSeen: value.lastSeen,
      })
      .onConflictDoUpdate({
        target: [hookSchemaFingerprints.eventType, hookSchemaFingerprints.fingerprint],
        set: {
          lastSeen: sql`GREATEST(${hookSchemaFingerprints.lastSeen}, EXCLUDED.last_seen)`,
        },
      });
    inserted++;
  }

  log.info({ inserted }, "backfill complete");
});
