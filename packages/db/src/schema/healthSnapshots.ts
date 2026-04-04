import { pgTable, text, integer, real, timestamp } from "drizzle-orm/pg-core";

export const healthSnapshots = pgTable("health_snapshots", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  timestamp: timestamp("timestamp", { mode: "string" }).notNull(),
  cpuPercent: real("cpu_percent"),
  ramPercent: real("ram_percent"),
  diskPercent: real("disk_percent"),
  dockerContainers: integer("docker_containers"),
  rawJson: text("raw_json"),
});
