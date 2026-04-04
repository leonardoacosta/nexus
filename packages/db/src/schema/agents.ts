import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").default(""),
  host: text("host").notNull(),
  port: integer("port").default(7400),
  projectsDir: text("projects_dir").default(""),
  enabled: boolean("enabled").default(true),
  lastSeen: timestamp("last_seen", { mode: "string" }),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow(),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
