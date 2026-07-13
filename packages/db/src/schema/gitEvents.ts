/**
 * git_events — append-only history of observed git transitions per registered
 * project: branch switches, new commits, and detached-head checkouts. One row
 * per detected transition; dirty working-tree state is deliberately NOT evented
 * (it is a state, not a transition) and lives only in the observer's in-memory
 * current-state map folded into the status payload.
 *
 * Spec: openspec/changes/add-git-status-orbit (git-event-store delta — revives
 * the committed-but-dead SQLite-era requirement on Postgres).
 *
 * Written by `apps/agent/src/services/git-observer.ts` — a 60s staggered poll
 * over locally-present registered project locations. The first observation of a
 * project after agent start establishes a baseline and emits no row. Read by
 * `GET /projects/:id/git-events?days=<n>` (capped at retention, oldest first).
 *
 * Project identity: `project` text (project name), consistent with
 * `spec_sessions` / `project_status_snapshots` and the observer's keying —
 * deliberately NOT the `projects` uuid, to keep the observer path free of
 * registry joins.
 *
 * `event_type` is an application-narrowed string kept as `text` (not an enum)
 * so a future transition kind can land without a follow-up migration, matching
 * the `cron_runs.status` convention:
 *   - "branch_switch"  — HEAD moved to a different branch (from_ref -> to_ref)
 *   - "new_commit"     — same branch, different HEAD sha (sha = new HEAD)
 *   - "detached_head"  — HEAD points at a bare sha (sha = detached HEAD)
 *
 * `from_ref` / `to_ref` / `sha` are all nullable because which fields are
 * populated depends on the event type (branch_switch fills from_ref/to_ref;
 * new_commit/detached_head fill sha).
 *
 * Retention: 90 days — pruned by `apps/agent/src/db/retention.ts`
 * (env-overridable via GIT_EVENTS_RETENTION_DAYS), matching
 * `cron_runs`/`project_status_snapshots` trend-window tables.
 *
 * Indices:
 *   - `(project, created_at)` composite — primary read path
 *     (GET /projects/:id/git-events?days=, oldest first)
 *   - `(created_at)`                    — retention prune scan
 */

import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const gitEvents = pgTable(
  "git_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    project: text("project").notNull(),
    eventType: text("event_type").notNull(),
    fromRef: text("from_ref"),
    toRef: text("to_ref"),
    sha: text("sha"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("git_events_project_created_at_idx").on(
      table.project,
      table.createdAt,
    ),
    index("git_events_created_at_idx").on(table.createdAt),
  ],
);

export type GitEvent = typeof gitEvents.$inferSelect;
export type NewGitEvent = typeof gitEvents.$inferInsert;
