/**
 * Notification persistence helpers.
 *
 * HISTORY (context-aware-routing, Phase 1): the in-memory `pendingIds` ring
 * buffer + the `buffer-meta.json` sidecar were REMOVED. They tracked held /
 * pending notification ids in process memory and lost every held item on agent
 * restart (systemd reload, post-merge deploy fan-out, OOM) — a real data-loss
 * bug. Durable meeting-holds now live in `presence_holds` via `held-queue.ts`.
 *
 * What remains here is the thin DB-CRUD over the `notifications` table (insert,
 * query-by-status, mark-delivered, mark-expired, get-by-id) plus the
 * `NotificationRow` row type that the manager, analytics, and `db/index.ts`
 * re-export. These are the DURABLE persistence path — they were never the
 * volatile part — so they stay.
 */

import type { Db } from "@nexus/db";
import { notifications } from "@nexus/db";
import type { NotificationStatus } from "@nexus/core";
import { eq, asc } from "drizzle-orm";

/** Row shape returned from the `notifications` table. */
export type NotificationRow = typeof notifications.$inferSelect;

/** Insert a notification row into the `notifications` table. */
export async function insertNotification(db: Db, row: NotificationRow): Promise<void> {
  await db.insert(notifications).values(row);
}

/** Query all notifications with a given status. */
export async function queryNotificationsByStatus(
  db: Db,
  status: NotificationStatus,
): Promise<NotificationRow[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.status, status))
    .orderBy(asc(notifications.createdAt))
    .limit(500);
}

/** Mark a notification as delivered. */
export async function markNotificationDelivered(db: Db, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "delivered", deliveryState: "delivered", sentAt: new Date() })
    .where(eq(notifications.id, id));
}

/** Mark a notification as expired. */
export async function markNotificationExpired(db: Db, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "expired", deliveryState: "failed" })
    .where(eq(notifications.id, id));
}

/** Get a single notification by id. */
export async function getNotificationById(
  db: Db,
  id: string,
): Promise<NotificationRow | null> {
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1);
  return rows[0] ?? null;
}
