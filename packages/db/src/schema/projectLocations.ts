import { boolean, pgTable, text, timestamp, uuid, integer, unique } from "drizzle-orm/pg-core";

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
    /**
     * Removable-reference flag. Distinct from `status` (archival lifecycle):
     * a hidden location is excluded from `/projects` and the auto-discovery
     * scanner MUST preserve `hidden=true` on re-scan (sticky exclude).
     */
    hidden: boolean("hidden").default(false).notNull(),
    activeSessions: integer("active_sessions").default(0).notNull(),
    totalSessions: integer("total_sessions").default(0).notNull(),
    lastDiscoveredAt: timestamp("last_discovered_at", { mode: "date", withTimezone: true }),
    priority: integer("priority").default(999).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow(),
  },
  (table) => [unique("project_locations_project_agent_unique").on(table.projectId, table.agentId)],
);

export type ProjectLocation = typeof projectLocations.$inferSelect;
export type NewProjectLocation = typeof projectLocations.$inferInsert;
