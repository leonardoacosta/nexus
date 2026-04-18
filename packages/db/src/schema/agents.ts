import { relations } from "drizzle-orm";
import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

import { sessions } from "./sessions";

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").default(""),
  host: text("host").notNull(),
  port: integer("port").default(7400),
  projectsDir: text("projects_dir").default(""),
  enabled: boolean("enabled").default(true),
  lastSeen: timestamp("last_seen", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
  deletedAt: timestamp("deleted_at", { mode: "date" }),
});

/**
 * Inverse relations for agents.
 *
 * Only `sessions` is wired: `sessions.machine` acts as the de-facto
 * foreign key to `agents.id` and `sessionsRelations` already defines
 * the forward `one(agents)` side.
 *
 * `healthSnapshots`, `credentials`, and `notifications` have no column
 * pointing at `agents.id`, so they cannot participate in a drizzle
 * relation here. See task nx-cy8o notes for the spec correction.
 */
export const agentsRelations = relations(agents, ({ many }) => ({
  sessions: many(sessions),
}));

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
