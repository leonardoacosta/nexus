import { pgTable, text, timestamp, uuid, integer, unique } from "drizzle-orm/pg-core";

export const projectLocations = pgTable(
  "project_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    agentId: text("agent_id").notNull(),
    path: text("path").notNull(),
    /** Git remote URL captured at discovery time for cross-agent dedup. */
    gitRemoteUrl: text("git_remote_url"),
    status: text("status").default("active").notNull(),
    activeSessions: integer("active_sessions").default(0).notNull(),
    totalSessions: integer("total_sessions").default(0).notNull(),
    lastDiscoveredAt: timestamp("last_discovered_at", { mode: "string" }),
    priority: integer("priority").default(999).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow(),
  },
  (table) => [unique("project_locations_project_agent_unique").on(table.projectId, table.agentId)],
);

export type ProjectLocation = typeof projectLocations.$inferSelect;
export type NewProjectLocation = typeof projectLocations.$inferInsert;
