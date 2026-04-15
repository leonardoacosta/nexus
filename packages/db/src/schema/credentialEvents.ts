import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const credentialEvents = pgTable(
  "credential_events",
  {
    id: text("id").primaryKey(),
    credentialId: text("credential_id").notNull(),
    eventType: text("event_type").notNull(),
    sessionId: text("session_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    credentialCreatedAtIdx: index(
      "credential_events_credential_created_at_idx",
    ).on(table.credentialId, table.createdAt),
    createdAtIdx: index("credential_events_created_at_idx").on(
      table.createdAt,
    ),
  }),
);
