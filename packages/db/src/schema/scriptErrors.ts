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

import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
    /**
     * OpenTelemetry trace id propagated from the originating span
     * (agent-payload-completeness). Nullable for legacy rows captured
     * before pino-db-transport was instrumented with OTel context.
     */
    traceId: text("trace_id"),
    /**
     * True when `stack` was truncated at ingest because it exceeded the
     * agent's configured threshold (default 4KB). Lets the Swift dashboard
     * surface a "stack truncated" affordance without re-deriving the
     * threshold client-side.
     */
    stackTruncated: boolean("stack_truncated").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
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
