import { relations } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { agents } from "./agents";
import { projects } from "./projects";

export const notifications = pgTable("notifications", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  project: text("project"),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  priority: text("priority").notNull().default("normal"),
  status: text("status").notNull().default("queued"),
  /**
   * Dashboard-facing severity enum (agent-payload-completeness): one of
   * `info` | `warn` | `error`. Distinct from `priority` (delivery hint —
   * low/normal/high) — severity is the visual urgency surface for the
   * Swift dashboard notifications view. Default `info` so legacy rows
   * remain decodable.
   */
  severity: text("severity").notNull().default("info"),
  /**
   * Dashboard-facing delivery lifecycle (agent-payload-completeness):
   * one of `pending` | `delivered` | `failed`. Mirrors `status` but uses
   * the Swift-facing enum spelling — `status` retains the legacy
   * `queued/delivered/expired` shape that the dispatcher writes against.
   * Default `pending` so existing rows backfill cleanly.
   */
  deliveryState: text("delivery_state").notNull().default("pending"),
  /**
   * Absolute path to the cached MP3 produced by ElevenLabs at synthesise
   * time (notifications-overhaul). Set when the Mac listener (or future
   * agent-side synthesiser) writes synthesised audio to
   * `~/.config/nexus/audio/<id>.mp3` via the audio-store helper. NULL when
   * TTS is disabled, synthesis failed, or the row predates this column.
   *
   * The file may have been pruned by the cron retention sweep even when
   * `audio_path` is set — consumers MUST `stat()` the path before serving
   * to disambiguate "never synthesised" (NULL, 404) vs "pruned"
   * (set-but-missing, 410 Gone).
   */
  audioPath: text("audio_path"),
  /**
   * ElevenLabs voice id that produced the audio referenced by
   * `audio_path`. Useful for debugging per-project voice resolution
   * (notifications-overhaul) — confirms which override fired without
   * round-tripping the resolver. NULL alongside `audio_path` when no
   * synthesis happened.
   */
  voiceUsed: text("voice_used"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  sentAt: timestamp("sent_at", { mode: "date" }),
});

/**
 * Logical relations for the `notifications` table.
 *
 * The `project` text column stores a project identifier (name) and is not
 * a Postgres-level foreign key, mirroring the existing convention used by
 * `sessions` (see `sessionsRelations`). The relation below enables nested
 * Drizzle relational queries (e.g. `db.query.notifications.findMany({ with: { project: true } })`)
 * without introducing a DB constraint or migration.
 */
export const notificationsRelations = relations(notifications, ({ one }) => ({
  project: one(projects, {
    fields: [notifications.project],
    references: [projects.id],
  }),
  agent: one(agents, {
    fields: [notifications.agentId],
    references: [agents.id],
  }),
}));
