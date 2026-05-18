/**
 * script_errors — durable error capture for one-off scripts.
 *
 * Spec: openspec/changes/enforce-pino-script-errors
 *
 * Fed by:
 *   - `packages/core/src/node/pino-db-transport.ts` (warn/error/fatal levels)
 *   - `withErrorCapture()` wrapper around every script's `main()`
 *
 * Retention: 30 days — pruned by `apps/agent/src/db/retention.ts`.
 */

import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const scriptErrors = pgTable(
  "script_errors",
  {
    id: text("id").primaryKey(),
    /** Logger name (createLogger argument) or script filename. */
    scriptName: text("script_name").notNull(),
    /** "warn" | "error" | "fatal" — narrow at the application layer. */
    level: text("level").notNull(),
    message: text("message").notNull(),
    stack: text("stack"),
    /** Free-form structured context — the pino record minus reserved fields. */
    context: jsonb("context"),
    machine: text("machine"),
    /** Set by withErrorCapture when the script exits non-zero. */
    exitCode: integer("exit_code"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("script_errors_script_created_idx").on(
      table.scriptName,
      table.createdAt,
    ),
    index("script_errors_created_at_idx").on(table.createdAt),
  ],
);

export type ScriptError = typeof scriptErrors.$inferSelect;
export type NewScriptError = typeof scriptErrors.$inferInsert;
