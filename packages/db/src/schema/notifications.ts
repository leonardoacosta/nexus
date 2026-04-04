import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const notifications = pgTable("notifications", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  project: text("project"),
  priority: text("priority").notNull().default("normal"),
  status: text("status").notNull().default("queued"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull(),
  sentAt: timestamp("sent_at", { mode: "string" }),
});
