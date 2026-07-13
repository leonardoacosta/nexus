/**
 * spec_snapshots — per-spec change-only time-series of openspec completion.
 * One row per (project, spec_name) whenever the spec-watcher recount differs
 * from the latest persisted row (completed / total task counts).
 *
 * Spec: openspec/changes/add-project-status-snapshots (spec-timeseries delta,
 * MODIFIED). Revives the committed-but-dead SQLite-era `spec_snapshots`
 * requirement on Postgres — implementation was lost in the 2026-04-03
 * SQLite -> Postgres migration.
 *
 * Written by `apps/agent/src/services/status-snapshots.ts` off the existing
 * spec-watcher tick/refresh path (change-only inserts keep the table small).
 * Read by `GET /projects/:id/status[?history=<days>]`.
 *
 * Retention: 90 days — pruned by `apps/agent/src/db/retention.ts`
 * (env-overridable via SPEC_SNAPSHOTS_RETENTION_DAYS), matching
 * `cron_runs`/`bloat_radar` trend-dashboard windows.
 *
 * Indices:
 *   - `(project, spec_name)` composite — primary read path (per-spec history)
 *   - `(created_at)`                    — retention prune scan
 */

import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const specSnapshots = pgTable(
  "spec_snapshots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    project: text("project").notNull(),
    specName: text("spec_name").notNull(),
    completed: integer("completed").notNull(),
    total: integer("total").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("spec_snapshots_spec_idx").on(table.project, table.specName),
    index("spec_snapshots_created_at_idx").on(table.createdAt),
  ],
);

export type SpecSnapshot = typeof specSnapshots.$inferSelect;
export type NewSpecSnapshot = typeof specSnapshots.$inferInsert;
