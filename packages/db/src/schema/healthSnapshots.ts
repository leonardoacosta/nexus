import { relations } from "drizzle-orm";
import { pgTable, text, integer, real, timestamp, index } from "drizzle-orm/pg-core";

import { agents } from "./agents";

export const healthSnapshots = pgTable(
  "health_snapshots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    timestamp: timestamp("timestamp", { mode: "date", withTimezone: true }).notNull(),
    agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    cpuPercent: real("cpu_percent"),
    ramPercent: real("ram_percent"),
    diskPercent: real("disk_percent"),
    dockerContainers: integer("docker_containers"),
    rawJson: text("raw_json"),
  },
  (table) => ({
    timestampIdx: index("health_snapshots_timestamp_idx").on(table.timestamp),
  }),
);

export const healthSnapshotsRelations = relations(healthSnapshots, ({ one }) => ({
  agent: one(agents, {
    fields: [healthSnapshots.agentId],
    references: [agents.id],
  }),
}));
