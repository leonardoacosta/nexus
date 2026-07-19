import { relations, sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uuid, unique, uniqueIndex } from "drizzle-orm/pg-core";

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
    discoveredAt: timestamp("discovered_at", { mode: "date", withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow(),
  },
  (table) => [
    // Composite unique: (name, git_remote_url). Covers projects that DO have
    // a remote — those are deduplicated across machines by (name, remote).
    unique("projects_name_git_remote_url_unique").on(
      table.name,
      table.gitRemoteUrl,
    ),
    // Partial unique: (name) WHERE git_remote_url IS NULL.
    // Postgres treats every NULL as distinct, so the composite unique above
    // never catches two local-only projects with the same name and no
    // remote — the auto-discovery scanner's `onConflictDoNothing()` (no
    // explicit target, so it relies on the DB to report ANY constraint
    // conflict) silently re-inserted a new row on every ~60s scan cycle
    // instead of no-op'ing. This partial index closes that gap so a
    // no-remote project name is unique on its own (nx-1zfkq).
    uniqueIndex("projects_name_null_remote_unique")
      .on(table.name)
      .where(sql`${table.gitRemoteUrl} IS NULL`),
  ],
);

export const projectsRelations = relations(projects, ({ many }) => ({
  sessions: many(sessions),
  locations: many(projectLocations),
}));

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
