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
