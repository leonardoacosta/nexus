import type { Database } from "bun:sqlite";
import type { NotificationStatus } from "@nexus/core";

/** Row shape stored in the `notifications` table. */
export interface NotificationRow {
  id: string;
  channel: string;
  title: string;
  body: string;
  project: string | null;
  priority: string;
  status: string;
  created_at: string;
  sent_at: string | null;
}

/** Insert a notification into the buffer. */
export function insertNotification(db: Database, row: NotificationRow): void {
  db.query(
    `INSERT INTO notifications (id, channel, title, body, project, priority, status, created_at, sent_at)
     VALUES ($id, $channel, $title, $body, $project, $priority, $status, $created_at, $sent_at)`,
  ).run({
    $id: row.id,
    $channel: row.channel,
    $title: row.title,
    $body: row.body,
    $project: row.project,
    $priority: row.priority,
    $status: row.status,
    $created_at: row.created_at,
    $sent_at: row.sent_at,
  });
}

/** Query all notifications with a given status. */
export function queryNotificationsByStatus(
  db: Database,
  status: NotificationStatus,
): NotificationRow[] {
  return db
    .query(`SELECT * FROM notifications WHERE status = $status ORDER BY created_at ASC`)
    .all({ $status: status }) as NotificationRow[];
}

/** Mark a notification as delivered. */
export function markNotificationDelivered(db: Database, id: string): void {
  db.query(
    `UPDATE notifications SET status = 'delivered', sent_at = $sent_at WHERE id = $id`,
  ).run({
    $id: id,
    $sent_at: new Date().toISOString(),
  });
}

/** Mark a notification as expired. */
export function markNotificationExpired(db: Database, id: string): void {
  db.query(`UPDATE notifications SET status = 'expired' WHERE id = $id`).run({
    $id: id,
  });
}

/** Get a single notification by id. */
export function getNotificationById(
  db: Database,
  id: string,
): NotificationRow | null {
  return (
    (db.query(`SELECT * FROM notifications WHERE id = $id`).get({ $id: id }) as
      | NotificationRow
      | undefined) ?? null
  );
}
