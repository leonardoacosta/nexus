import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * `process_watcher_state` records each tick of the process-watcher health
 * monitor — how many CC processes were observed live, how long the scan took,
 * and any error surfaced while iterating /proc (Linux) or running `ps`
 * (macOS). Rows are append-only; retention is enforced by the cron cleanup
 * task in the agent. Spec: process-watcher-health-monitoring.
 */
export const processWatcherState = pgTable("process_watcher_state", {
  id: serial("id").primaryKey(),
  observedAt: timestamp("observed_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  livePidCount: integer("live_pid_count").notNull(),
  tickDurationMs: integer("tick_duration_ms").notNull(),
  errorText: text("error_text"),
});

export type ProcessWatcherState = typeof processWatcherState.$inferSelect;
export type NewProcessWatcherState = typeof processWatcherState.$inferInsert;
