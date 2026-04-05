import type { Db } from "@nexus/db";
import { notifications } from "@nexus/db";
import type { NotificationStatus } from "@nexus/core";
import { createLogger } from "@nexus/core";
import { eq, asc } from "drizzle-orm";

const log = createLogger("agent:notifications:buffer");

/** Maximum number of in-flight notification records tracked in memory. */
export const MAX_BUFFER_SIZE = 1000;

/** In-memory ring buffer of pending notification ids (LRU eviction at cap). */
const pendingIds: string[] = [];

/** Row shape returned from the `notifications` table. */
export type NotificationRow = typeof notifications.$inferSelect;

/** Insert a notification into the buffer, evicting the oldest entry if at capacity. */
export async function insertNotification(db: Db, row: NotificationRow): Promise<void> {
  if (pendingIds.length >= MAX_BUFFER_SIZE) {
    const dropped = pendingIds.shift();
    log.warn({ dropped }, "notification buffer eviction");
  }
  pendingIds.push(row.id);
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
