import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  project: text("project").notNull(),
  machine: text("machine").notNull(),
  status: text("status").notNull().default("active"),
  startedAt: timestamp("started_at", { mode: "string" }).notNull(),
  lastActivity: timestamp("last_activity", { mode: "string" }).notNull(),
  endedAt: timestamp("ended_at", { mode: "string" }),
  pid: integer("pid"),
  cwd: text("cwd"),
});
