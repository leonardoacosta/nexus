/**
 * workflow_run — system-of-record for individual cc workflow:* tool runs
 * (per add-metrics-system-of-record, Phase 1).
 *
 * One row per tool invocation. `id` is `<tool>-<ts>` (stable) so the outbox
 * drainer can upsert idempotently (INSERT ... ON CONFLICT (id) DO UPDATE).
 * The full run record lives in `payload` jsonb so the schema stays stable as
 * tools evolve; `tool` + `ts` are promoted to typed columns for the Grafana
 * trend index.
 */

import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const workflowRun = pgTable(
  "workflow_run",
  {
    /** `<tool>-<ts>` — stable id for idempotent drain. */
    id: text("id").primaryKey(),
    tool: text("tool").notNull(),
    ts: timestamp("ts", { mode: "date", withTimezone: true }).notNull(),
    toolVersion: jsonb("tool_version"),
    payload: jsonb("payload"),
  },
  (table) => [index("workflow_run_tool_ts_idx").on(table.tool, table.ts)],
);

export type WorkflowRun = typeof workflowRun.$inferSelect;
export type NewWorkflowRun = typeof workflowRun.$inferInsert;
