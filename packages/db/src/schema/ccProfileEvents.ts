/**
 * cc_profile_events — observability stream for cc-credential-manager.
 *
 * Renamed from `credential_events` per add-cc-credential-manager. Event types
 * include:
 *  - CCProfileObserved        — manager noticed a new profile in credentials.json
 *  - CCProfileRefreshed       — proactive OAuth refresh completed
 *  - CCProfileSwapped         — rate-limit (429) triggered swap to next profile
 *  - CCAuthSchemaDrift        — credentials.json fingerprint diverged
 *  - CCCredentialsBackupWrote — backup-before-write snapshot persisted
 */

import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const ccProfileEvents = pgTable(
  "cc_profile_events",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull(),
    eventType: text("event_type").notNull(),
    sessionId: text("session_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("cc_profile_events_profile_created_at_idx").on(
      table.profileId,
      table.createdAt,
    ),
    index("cc_profile_events_created_at_idx").on(table.createdAt),
  ],
);

export type CcProfileEvent = typeof ccProfileEvents.$inferSelect;
export type NewCcProfileEvent = typeof ccProfileEvents.$inferInsert;
