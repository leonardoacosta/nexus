/**
 * hook_schema_fingerprints — schema drift detection for CC hook payloads.
 *
 * Spec: openspec/changes/add-schema-drift-detector
 *
 * Each row records one observed (event_type, fingerprint) pair where the
 * fingerprint is a SHA-256 over the sorted top-level key set of an incoming
 * hook payload. `first_seen` is set on INSERT; `last_seen` is bumped on
 * subsequent observations (rate-limited at the application layer).
 *
 * Schema drift is detected by `services/schema-drift.ts` — a new
 * (event_type, fingerprint) pair triggers a `HookSchemaDrift` lifecycle
 * event (rate-limited 1 fire / event_type / hour).
 */

import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const hookSchemaFingerprints = pgTable(
  "hook_schema_fingerprints",
  {
    /** Event type name (e.g. "PreToolUse", "session_start"). */
    eventType: text("event_type").notNull(),
    /** SHA-256 of the sorted top-level key set for this payload shape. */
    fingerprint: text("fingerprint").notNull(),
    /** First time this (event_type, fingerprint) pair was observed. */
    firstSeen: timestamp("first_seen", { mode: "date" }).notNull().defaultNow(),
    /** Last time this (event_type, fingerprint) pair was observed. */
    lastSeen: timestamp("last_seen", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("hook_schema_fingerprints_event_fp_uidx").on(
      table.eventType,
      table.fingerprint,
    ),
    index("hook_schema_fingerprints_event_idx").on(table.eventType),
  ],
);

export type HookSchemaFingerprint = typeof hookSchemaFingerprints.$inferSelect;
export type NewHookSchemaFingerprint = typeof hookSchemaFingerprints.$inferInsert;
