import type { Db } from "@nexus/db";
import { notifications } from "@nexus/db";
import type { NotificationStatus } from "@nexus/core";
import { eq, asc } from "drizzle-orm";

/** Row shape returned from the `notifications` table. */
export type NotificationRow = typeof notifications.$inferSelect;

/** Insert a notification into the buffer. */
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
    .orderBy(asc(notifications.createdAt));
}

/** Mark a notification as delivered. */
export async function markNotificationDelivered(db: Db, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "delivered", sentAt: new Date().toISOString() })
    .where(eq(notifications.id, id));
}

/** Mark a notification as expired. */
export async function markNotificationExpired(db: Db, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "expired" })
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
