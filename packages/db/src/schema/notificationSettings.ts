import { pgTable, integer, boolean, text, timestamp } from "drizzle-orm/pg-core";

/**
 * `notification_settings` is a single-row sentinel table (id = 1) holding the
 * runtime toggles for the Mac notifier dispatch pipeline. The bootstrap row is
 * inserted by the migration; mutations are PATCH-style updates that always
 * target id = 1.
 *
 * `ducking_mode` is stored as `text` constrained at the application layer to
 * `"full" | "half" | "mute"` rather than a `pgEnum` to keep migrations cheap
 * (adding a new mode is a code change, not an `ALTER TYPE`).
 */
export const notificationSettings = pgTable("notification_settings", {
  id: integer("id").primaryKey().default(1),
  ttsEnabled: boolean("tts_enabled").notNull().default(true),
  bannerEnabled: boolean("banner_enabled").notNull().default(true),
  duckingMode: text("ducking_mode")
    .$type<"full" | "half" | "mute">()
    .notNull()
    .default("full"),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export type NotificationSettings = typeof notificationSettings.$inferSelect;
export type NewNotificationSettings = typeof notificationSettings.$inferInsert;
