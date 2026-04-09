import {
  pgTable,
  text,
  integer,
  timestamp,
  real,
  doublePrecision,
} from "drizzle-orm/pg-core";

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  project: text("project").notNull(),
  machine: text("machine").notNull(),
  status: text("status").notNull().default("active"),
  startedAt: timestamp("started_at", { mode: "date" }).notNull(),
  lastActivity: timestamp("last_activity", { mode: "date" }).notNull(),
  endedAt: timestamp("ended_at", { mode: "date" }),
  pid: integer("pid"),
  cwd: text("cwd"),

  // Extended fields — added in migration 0005
  branch: text("branch"),
  sessionType: text("session_type"),
  model: text("model"),
  rateLimitUtilization: real("rate_limit_utilization"),
  totalCostUsd: doublePrecision("total_cost_usd"),
  rateLimitResetAt: timestamp("rate_limit_reset_at", { mode: "date" }),
  idleSince: timestamp("idle_since", { mode: "date" }),
  projectId: text("project_id"),
  ccSessionId: text("cc_session_id"),
  tmuxSession: text("tmux_session"),
  tmuxTarget: text("tmux_target"),
  spec: text("spec"),
});
