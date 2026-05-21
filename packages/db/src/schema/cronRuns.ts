/**
 * cron_runs — telemetry row per nx-cron job execution.
 *
 * Spec: openspec/changes/adopt-reaper-into-nx-cron (cron-persistence capability).
 *
 * Written by the in-process cron service after each job tick (e.g. the weekly
 * `reaper` job ported from the chezmoi `weekly-cleanup` script). One row per
 * run — success, failure, or aborted via the `_on_exit` silent-abort trap.
 *
 * Status values are application-narrowed strings, kept as `text` instead of an
 * enum so new job kinds can land without a follow-up migration:
 *   - "success"  — job ran to completion (counts may still be zero)
 *   - "failure"  — job exited non-zero or the wrapper rejected the result
 *   - "aborted"  — the bash core fired the `_on_exit` silent-abort trap
 *
 * `details` carries the structured per-run summary (counts, freed bytes, log
 * path, bloat-finding count) and `metrics` carries the numeric counters the
 * dashboard trends over time. Both are `jsonb` so the dashboard can index into
 * them without re-parsing text.
 *
 * Retention: 90 days — pruned by `apps/agent/src/db/retention.ts`.
 */

import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const cronRuns = pgTable(
  "cron_runs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    timestamp: timestamp("timestamp", { mode: "date" }).notNull(),
    job: text("job").notNull(),
    status: text("status").notNull(),
    details: jsonb("details"),
    metrics: jsonb("metrics"),
  },
  (table) => ({
    timestampIdx: index("cron_runs_timestamp_idx").on(table.timestamp),
  }),
);

export type CronRun = typeof cronRuns.$inferSelect;
export type NewCronRun = typeof cronRuns.$inferInsert;
