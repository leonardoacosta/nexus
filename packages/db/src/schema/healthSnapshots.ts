import { pgTable, text, integer, real, timestamp, index } from "drizzle-orm/pg-core";

export const healthSnapshots = pgTable(
  "health_snapshots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    timestamp: timestamp("timestamp", { mode: "date" }).notNull(),
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
