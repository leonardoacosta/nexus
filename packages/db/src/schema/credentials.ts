import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const credentials = pgTable("credentials", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  valueEncrypted: text("value_encrypted").notNull(),
  status: text("status").notNull().default("available"),
  leasedBy: text("leased_by"),
  leasedAt: timestamp("leased_at", { mode: "string" }),
  cooldownUntil: timestamp("cooldown_until", { mode: "string" }),
});
