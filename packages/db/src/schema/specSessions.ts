/**
 * spec_sessions — many-to-many join between specs (project + name slug) and
 * sessions (session_id). Survives session close; the row stays so historical
 * lookups ("which sessions touched spec X?") work.
 *
 * Spec: openspec/changes/specs-tab-start-on-spec.
 *
 * Written by `apps/agent/src/services/session-spec-link.ts` after a successful
 * `POST /session/start` with an optional `spec_slug` body field. Read by
 * `GET /specs/:project/:name/sessions` to render the Swift dashboard's session
 * count chip per proposal row.
 *
 * Retention: 365 days — pruned by `apps/agent/src/db/retention.ts`. Longer
 * than `cron_runs` (90d) because this powers historical lookup queries the
 * user navigates to from the Specs tab, not just trend dashboards.
 *
 * Indices:
 *   - `(project, spec_name)` composite — primary read path
 *     (GET /specs/:project/:name/sessions)
 *   - `(session_id)`                   — reverse lookup ("which specs did
 *     this session touch?")
 */

import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const specSessions = pgTable(
  "spec_sessions",
  {
    // NOTE: design.md proposed `text` here but `generatedAlwaysAsIdentity()`
    // is only valid on integer columns; matching the existing convention
    // (cron_runs, bloat_radar, health_snapshots, session_events).
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    project: text("project").notNull(),
    specName: text("spec_name").notNull(),
    sessionId: text("session_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("spec_sessions_spec_idx").on(table.project, table.specName),
    index("spec_sessions_session_idx").on(table.sessionId),
  ],
);

export type SpecSession = typeof specSessions.$inferSelect;
export type NewSpecSession = typeof specSessions.$inferInsert;
