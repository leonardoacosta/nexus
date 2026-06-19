/**
 * presence_holds — durable queue for notifications held by the presence
 * rules engine (e.g. "in a meeting -> hold until the meeting ends").
 *
 * Spec: openspec/changes/context-aware-routing (Phase 1).
 *
 * Replaces the old in-memory buffer (`meeting-state.ts` + `buffer.ts`) which
 * lost held items on agent restart. The held-queue service reloads pending
 * holds on boot and schedules a flush at `hold_until`; on flush the row is
 * marked `released_at` and a `PresenceHoldReleased` lifecycle event fires.
 *
 * `payload` is the full held notification, stored as `jsonb` so the dashboard
 * can index into it without re-parsing text.
 */

import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The held notification payload. Kept structurally loose at the DB layer — the
 * agent narrows it via `packages/core` notification types at read time.
 */
export interface PresenceHoldPayload {
  title: string;
  body?: string;
  project?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export const presenceHolds = pgTable(
  "presence_holds",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** The held notification, restored verbatim on flush. */
    payload: jsonb("payload").$type<PresenceHoldPayload>().notNull(),
    /** When the hold should be flushed (e.g. meeting end + grace). */
    holdUntil: timestamp("hold_until", { mode: "date" }).notNull(),
    /** Why it was held (rule id / human-readable reason). */
    reason: text("reason"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    /** Set when the hold is flushed; null while pending. */
    releasedAt: timestamp("released_at", { mode: "date" }),
  },
  (table) => [
    index("presence_holds_user_hold_until_idx").on(
      table.userId,
      table.holdUntil,
    ),
  ],
);

export type PresenceHold = typeof presenceHolds.$inferSelect;
export type NewPresenceHold = typeof presenceHolds.$inferInsert;
