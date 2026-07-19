import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { sessions } from "./sessions";

export const sessionEvents = pgTable("session_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  eventType: text("event_type").notNull(),
  timestamp: timestamp("timestamp", { mode: "date", withTimezone: true }).notNull(),
  metadata: text("metadata"),
});
