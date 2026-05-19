import { relations } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";

import { projectLocations } from "./projectLocations";
import { sessions } from "./sessions";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Git remote URL for the origin — used as a stable cross-machine identity key. */
    gitRemoteUrl: text("git_remote_url"),
    primaryAgentId: text("primary_agent_id").notNull(),
    description: text("description"),
    tags: text("tags").array(),
    status: text("status").default("active").notNull(),
    /**
     * Removable-reference flag. Distinct from `status` (archival lifecycle):
     * a hidden project is excluded from `/projects` and the auto-discovery
     * scanner MUST preserve `hidden=true` on re-scan (sticky exclude).
     */
    hidden: boolean("hidden").default(false).notNull(),
    discoveredAt: timestamp("discovered_at", { mode: "date" }).defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
  },
  (table) => [
    // Composite unique: (name, git_remote_url).
    // Two NULLs are NOT equal in SQL, so two local-only projects with the
    // same name but no remote can coexist. Projects with the same remote URL
    // are deduplicated across machines.
    unique("projects_name_git_remote_url_unique").on(
      table.name,
      table.gitRemoteUrl,
    ),
  ],
);

export const projectsRelations = relations(projects, ({ many }) => ({
  sessions: many(sessions),
  locations: many(projectLocations),
}));

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
