import type { Db } from "@nexus/db";
import { logger } from "@nexus/core/node";
import {
  insertNotification,
  queryNotificationsByStatus,
  markNotificationDelivered,
  markNotificationExpired,
} from "./buffer";
import type { NotificationRow } from "./buffer";
import { MeetingState } from "./meeting-state";
import { routeNotification, findMatchingRule, routeNotificationParallel } from "./router";
import { lifecycleBus } from "../services/lifecycle-bus";

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

  /** Flush all buffered (queued) notifications — called when meeting ends.
   *
   * Uses parallel delivery via Promise.allSettled so all notifications are
   * attempted concurrently. A single failure does not block others.
   */
  async flush(): Promise<number> {
    const queued = await queryNotificationsByStatus(this.db, "queued");

    // Parallel delivery — partial failures are isolated (D4).
    const results = await Promise.allSettled(
      queued.map((n) => this.deliverNotification(n)),
    );

    const delivered = results.filter(
      (r) => r.status === "fulfilled" && r.value,
    ).length;
    const failed = results.filter((r) => r.status === "rejected").length;

    if (failed > 0) {
      logger.warn(
        { total: queued.length, delivered, failed },
        "notification flush complete (partial failure)",
      );
    } else {
      logger.info({ total: queued.length, delivered }, "notification flush complete");
    }

    return delivered;
  }

  /** Deliver a single notification via the router using parallel channel delivery. */
  private async deliverNotification(notification: NotificationRow): Promise<boolean> {
    // Use parallel delivery with partial-success reporting (D4).
    const { delivered, failed } = await routeNotificationParallel(notification);

    const anyDelivered = delivered.length > 0;

    if (anyDelivered) {
      await markNotificationDelivered(this.db, notification.id);
      notification.status = "delivered";

      // Emit NotificationFired on the lifecycle bus so SSE subscribers
      // (e.g. Mac-side listener) can dispatch osascript/say locally.
      // Fires once per notification, not once per channel.
      for (const channel of delivered) {
        lifecycleBus.emit("NotificationFired", {
          id: notification.id,
          title: notification.title,
          body: notification.body,
          channel,
          project: notification.project ?? undefined,
          message: notification.body, // back-compat alias
        });
      }
    }

    if (failed.length > 0) {
      logger.warn(
        { id: notification.id, delivered, failed },
        failed.length === delivered.length + failed.length
          ? "notification delivery failed on all channels"
          : "notification delivery partial failure",
      );
    }

    return anyDelivered;
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
