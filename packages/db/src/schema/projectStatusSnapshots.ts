/**
 * project_status_snapshots — per-project change-only time-series of aggregate
 * status counts: unarchived openspec proposals, plus beads that are ready or
 * blocked AND unlinked from any proposal. One row per project whenever either
 * watcher's recount differs from the latest persisted row.
 *
 * Spec: openspec/changes/add-project-status-snapshots (spec-timeseries delta,
 * ADDED).
 *
 * Written by `apps/agent/src/services/status-snapshots.ts` from the
 * beads-watcher recount callback (ready/blocked-unlinked) and the spec-watcher
 * tick (proposals_unarchived). Change-only inserts keep the table small. Read
 * by `GET /projects/:id/status[?history=<days>]` and drives the BeadTransition
 * lifecycle-bus event.
 *
 * Project identity: `project` text (project name), consistent with
 * `spec_sessions` and the spec-watcher's keying — deliberately NOT the
 * `projects` uuid, to keep the watcher path free of registry joins.
 *
 * Retention: 90 days — pruned by `apps/agent/src/db/retention.ts`
 * (env-overridable via PROJECT_STATUS_SNAPSHOTS_RETENTION_DAYS), matching
 * `cron_runs`/`bloat_radar` trend-dashboard windows.
 *
 * Indices:
 *   - `(project)`      — primary read path (latest + history for one project)
 *   - `(created_at)`   — retention prune scan
 */

import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const projectStatusSnapshots = pgTable(
  "project_status_snapshots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    project: text("project").notNull(),
    proposalsUnarchived: integer("proposals_unarchived").notNull(),
    beadsReadyUnlinked: integer("beads_ready_unlinked").notNull(),
    beadsBlockedUnlinked: integer("beads_blocked_unlinked").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("project_status_snapshots_project_idx").on(table.project),
    index("project_status_snapshots_created_at_idx").on(table.createdAt),
  ],
);

export type ProjectStatusSnapshot = typeof projectStatusSnapshots.$inferSelect;
export type NewProjectStatusSnapshot =
  typeof projectStatusSnapshots.$inferInsert;
