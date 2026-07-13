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
 *
 * The presence-routing columns (`presence_aware_routing`,
 * `unknown_noncritical_mode`, `unknown_critical_mode`) belong to
 * openspec/changes/context-aware-routing. They gate the additive presence
 * layer (default off -> legacy single-toggle behavior) and pick the staleness
 * fail policy when the presence vector is `unknown` past its TTL: non-critical
 * defaults to `fail-safe` (don't interrupt), critical to `fail-open` (deliver
 * anyway). Stored as `text` narrowed at the application layer, same rationale
 * as `ducking_mode`.
 */
export const notificationSettings = pgTable("notification_settings", {
  id: integer("id").primaryKey().default(1),
  ttsEnabled: boolean("tts_enabled").notNull().default(true),
  bannerEnabled: boolean("banner_enabled").notNull().default(true),
  duckingMode: text("ducking_mode")
    .$type<"full" | "half" | "mute">()
    .notNull()
    .default("full"),
  presenceAwareRouting: boolean("presence_aware_routing")
    .notNull()
    .default(false),
  unknownNoncriticalMode: text("unknown_noncritical_mode")
    .$type<"fail-safe" | "fail-open">()
    .notNull()
    .default("fail-safe"),
  unknownCriticalMode: text("unknown_critical_mode")
    .$type<"fail-open" | "fail-safe">()
    .notNull()
    .default("fail-open"),
  bedtimeSources: text("bedtime_sources")
    .$type<"hk" | "focus" | "either" | "both">()
    .notNull()
    .default("either"),
  /**
   * Project-scoped TTS rate throttle (noise-reduction audit, 2026-07-13).
   * When a project has fired `rateThrottleMaxPerWindow` or more TTS
   * notifications within the trailing `rateThrottleWindowMinutes`, further
   * non-critical (priority != "high") TTS notifications for that project are
   * delivered as a silent desktop notification instead — see
   * NotificationManager.send() in apps/agent/src/notifications/manager.ts.
   */
  rateThrottleEnabled: boolean("rate_throttle_enabled").notNull().default(true),
  rateThrottleMaxPerWindow: integer("rate_throttle_max_per_window")
    .notNull()
    .default(5),
  rateThrottleWindowMinutes: integer("rate_throttle_window_minutes")
    .notNull()
    .default(5),
  /**
   * Wall-clock quiet-hours gate (noise-reduction audit, 2026-07-13, plan
   * 042). Applies ONLY on the presence-unknown / legacy notification path
   * (see NotificationManager.applyQuietHoursIfNeeded() in
   * apps/agent/src/notifications/manager.ts) — it does not affect the
   * presence-aware rules engine's own Rule 1 (active Mac beats bedtime, by
   * design) or Rule 3 (phone-reported bedtime). `startHour`/`endHour` are
   * hour-of-day (0-23, server local time); a window that wraps past midnight
   * (e.g. start=22, end=7) is supported.
   */
  quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(true),
  quietHoursStartHour: integer("quiet_hours_start_hour").notNull().default(0),
  quietHoursEndHour: integer("quiet_hours_end_hour").notNull().default(7),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export type NotificationSettings = typeof notificationSettings.$inferSelect;
export type NewNotificationSettings = typeof notificationSettings.$inferInsert;
