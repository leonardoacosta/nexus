import type { Db } from "@nexus/db";
import { logger } from "@nexus/core";
import {
  insertNotification,
  queryNotificationsByStatus,
  markNotificationDelivered,
  markNotificationExpired,
} from "./buffer";
import type { NotificationRow } from "./buffer";
import { MeetingState } from "./meeting-state";
import { routeNotification, findMatchingRule } from "./router";

/**
 * Notification manager — orchestrates the lifecycle:
 * check meeting state -> buffer or route -> flush on meeting end.
 */
export class NotificationManager {
  private meetingState: MeetingState;
  private db: Db;

  constructor(db: Db, meetingState?: MeetingState) {
    this.db = db;
    this.meetingState = meetingState ?? new MeetingState();
  }

  /** Get the meeting state instance. */
  getMeetingState(): MeetingState {
    return this.meetingState;
  }

  /**
   * Send a notification: check meeting state, then buffer or route.
   * Returns the notification row with its assigned id.
   */
  async send(notification: Omit<NotificationRow, "status" | "sentAt">): Promise<NotificationRow> {
    const row: NotificationRow = {
      ...notification,
      status: "queued",
      sentAt: null,
    };

    // Always persist to buffer first
    await insertNotification(this.db, row);

    // Check meeting state
    if (this.meetingState.active) {
      const rule = findMatchingRule(row);

      if (rule.meeting_behavior === "drop") {
        // Drop: mark as expired immediately
        await markNotificationExpired(this.db, row.id);
        row.status = "expired";
        logger.info({ id: row.id }, "notification dropped (meeting active, rule=drop)");
        return row;
      }

      if (rule.meeting_behavior === "buffer") {
        // Buffer: keep as queued, will be flushed when meeting ends
        logger.info({ id: row.id }, "notification buffered (meeting active)");
        return row;
      }

      // "allow" — fall through to delivery
    }

    // Deliver now
    await this.deliverNotification(row);
    return row;
  }

  /** Flush all buffered (queued) notifications — called when meeting ends. */
  async flush(): Promise<number> {
    const queued = await queryNotificationsByStatus(this.db, "queued");
    let delivered = 0;

    for (const notification of queued) {
      const success = await this.deliverNotification(notification);
      if (success) delivered++;
    }

    logger.info({ total: queued.length, delivered }, "notification flush complete");

    return delivered;
  }

  /** Deliver a single notification via the router. */
  private async deliverNotification(notification: NotificationRow): Promise<boolean> {
    const results = await routeNotification(notification);
    const allSucceeded = results.length > 0 && results.every((r) => r.success);

    if (allSucceeded) {
      await markNotificationDelivered(this.db, notification.id);
      notification.status = "delivered";
    }

    return allSucceeded;
  }

  /** Start meeting mode. */
  startMeeting(): void {
    this.meetingState.start();
    logger.info("meeting started — notifications will be buffered");
  }

  /** End meeting mode and flush buffered notifications. */
  async endMeeting(): Promise<number> {
    this.meetingState.end();
    logger.info("meeting ended — flushing buffered notifications");
    return this.flush();
  }
}
