import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const credentials = pgTable("credentials", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  valuePlaintext: text("value_plaintext").notNull(),
  status: text("status").notNull().default("available"),
  leasedBy: text("leased_by"),
  leasedAt: timestamp("leased_at", { mode: "string" }),
  cooldownUntil: timestamp("cooldown_until", { mode: "string" }),
});
