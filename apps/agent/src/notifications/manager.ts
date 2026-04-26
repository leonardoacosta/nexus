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
    // The TTS channel reads its db handle via `getElevenlabsDb()` from the
    // shared runtime module. `startServer()` installs that handle once at
    // boot; the manager no longer threads it through. See
    // apps/agent/src/credentials/elevenlabs-runtime.ts.
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

      // Emit NotificationFired on the lifecycle bus once per delivered
      // channel. SSE subscribers (e.g. Mac-side `nexus-notifier` daemon)
      // dispatch on the channel name and use audioBase64 (TTS only) to
      // pipe the mp3 bytes into a local audio sink.
      for (const { channel, audioBase64 } of delivered) {
        lifecycleBus.emit("NotificationFired", {
          id: notification.id,
          title: notification.title,
          body: notification.body,
          channel,
          project: notification.project ?? undefined,
          audioBase64,
          message: notification.body, // back-compat alias
        });
      }
    }

    if (failed.length > 0) {
      const deliveredNames = delivered.map((d) => d.channel);
      logger.warn(
        { id: notification.id, delivered: deliveredNames, failed },
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
