import { relations } from "drizzle-orm";
import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

import { elevenlabsCredentials } from "./elevenlabsCredentials";
import { sessions } from "./sessions";

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").default(""),
  host: text("host").notNull(),
  port: integer("port").default(7400),
  projectsDir: text("projects_dir").default(""),
  enabled: boolean("enabled").default(true),
  lastSeen: timestamp("last_seen", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow(),
  deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
});

/**
 * Inverse relations for agents.
 *
 * `sessions` is wired via `sessions.machine` (de-facto FK to `agents.id`),
 * and `elevenlabsCredentials` via its `agent_id` FK (ON DELETE CASCADE).
 *
 * `healthSnapshots` and `notifications` have no column pointing at
 * `agents.id`, so they cannot participate in a drizzle relation here.
 * `credentials.agentId` is nullable (shared-pool semantics) and its
 * inverse is intentionally left off. See task nx-cy8o notes.
 */
export const agentsRelations = relations(agents, ({ many }) => ({
  sessions: many(sessions),
  elevenlabsCredentials: many(elevenlabsCredentials),
}));

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
