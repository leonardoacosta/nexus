/**
 * bloat_radar — per-finding row for over-threshold disk artifacts.
 *
 * Spec: openspec/changes/adopt-reaper-into-nx-cron (cron-persistence capability).
 *
 * Written by the `reaper` job wrapper for each finding the bash core's
 * `bloat_radar()` scan emits. A "clear" run writes ZERO rows — the empty set
 * is the signal that nothing exceeded threshold this week. Each finding row
 * is keyed by `runTimestamp` (the parent `cron_runs.timestamp`) so the
 * dashboard can join the radar findings back to their parent run.
 *
 * `sizeBytes` and `thresholdBytes` are stored as bigint-shaped numerics using
 * Drizzle's `integer` — Postgres `integer` tops out at ~2 GiB. The radar
 * already operates in megabyte/gigabyte territory, so we store the value in
 * BYTES as an `integer` only after the wrapper has narrowed; if findings
 * ever exceed 2 GiB the wrapper rounds to MiB before insert (see
 * `apps/agent/src/services/reaper-job.ts`).
 *
 * Retention: 90 days — pruned by `apps/agent/src/db/retention.ts`.
 */

import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const bloatRadar = pgTable(
  "bloat_radar",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    runTimestamp: timestamp("run_timestamp", { mode: "date", withTimezone: true }).notNull(),
    label: text("label").notNull(),
    path: text("path").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    thresholdBytes: integer("threshold_bytes").notNull(),
  },
  (table) => ({
    runTimestampIdx: index("bloat_radar_run_timestamp_idx").on(table.runTimestamp),
  }),
);

export type BloatRadar = typeof bloatRadar.$inferSelect;
export type NewBloatRadar = typeof bloatRadar.$inferInsert;
