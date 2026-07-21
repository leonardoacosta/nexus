// project_voice_overrides — per-project ElevenLabs voice id mapping.
//
// Spec: openspec/changes/notifications-overhaul (task 1.2)
//
// Single row per project. The TTSObserver consults this table on each
// synthesise call (via GET /notifications/voices) to resolve the voice id;
// falls back to the global Keychain `elevenLabsVoiceId` when no row exists.
// Updates emit a `VoiceOverrideChanged` event on the SSE stream so long-
// lived observers refresh their cache without a poll cycle.

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const projectVoiceOverrides = pgTable("project_voice_overrides", {
  /**
   * Project slug (matches `notifications.project` and `projects.name`).
   * No FK constraint — slugs are written by callers without registry
   * resolution, same convention as `notifications.project`.
   */
  project: text("project").primaryKey(),
  /**
   * Qualified `provider:voice` string (e.g. `elevenlabs:21m00Tcm4TlvDq8ikWAM`,
   * `kokoro:af_bella`). A bare voice id with no `provider:` prefix is
   * backward-compat shorthand for `elevenlabs:<id>`. Required. Column type
   * unchanged — still `text`, no migration.
   */
  voiceId: text("voice_id").notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ProjectVoiceOverride = typeof projectVoiceOverrides.$inferSelect;
export type NewProjectVoiceOverride = typeof projectVoiceOverrides.$inferInsert;
