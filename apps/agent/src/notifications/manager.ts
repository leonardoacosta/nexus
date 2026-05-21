import type { Db } from "@nexus/db";
import { notifications as notificationsTable } from "@nexus/db";
import { eq } from "drizzle-orm";
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
import { writeAudio } from "./audio-store";

/**
 * Transient transport-only fields threaded through the `NotificationFired`
 * lifecycle payload but NOT persisted on the `notifications` row.
 *
 * Added by `adopt-reaper-into-nx-cron` (`items` + `logPath`). Emitters that
 * want a structured bullet-list / open-log activation pass these alongside
 * `send()`; the Mac listener reads them off the SSE envelope.
 */
export interface NotificationTransportExtras {
  items?: string[];
  logPath?: string;
}

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
   *
   * `extras` carries transient transport-only fields (`items`, `logPath`)
   * that travel through the lifecycle `NotificationFired` payload but are
   * NOT persisted on the `notifications` row. Threaded by
   * `adopt-reaper-into-nx-cron` so structured bullet-list + open-log
   * activation work without a schema change.
   */
  async send(
    notification: Omit<
      NotificationRow,
      "status" | "sentAt" | "severity" | "deliveryState" | "audioPath" | "voiceUsed"
    > &
      Partial<
        Pick<
          NotificationRow,
          "severity" | "deliveryState" | "audioPath" | "voiceUsed"
        >
      >,
    extras?: NotificationTransportExtras,
  ): Promise<NotificationRow> {
    const row: NotificationRow = {
      ...notification,
      status: "queued",
      sentAt: null,
      // Dashboard-facing enums (agent-payload-completeness). Defaults
      // match the DB column defaults so existing callers continue to
      // work without passing them through.
      severity: notification.severity ?? "info",
      deliveryState: notification.deliveryState ?? "pending",
      // notifications-overhaul (task 1.1) — both null until the synth
      // pipeline records audio via `recordSynthesisedAudio()` below.
      audioPath: notification.audioPath ?? null,
      voiceUsed: notification.voiceUsed ?? null,
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
    await this.deliverNotification(row, extras);
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
  private async deliverNotification(
    notification: NotificationRow,
    extras?: NotificationTransportExtras,
  ): Promise<boolean> {
    // Use parallel delivery with partial-success reporting (D4).
    const { delivered, failed } = await routeNotificationParallel(notification);

    const anyDelivered = delivered.length > 0;

    if (anyDelivered) {
      await markNotificationDelivered(this.db, notification.id);
      notification.status = "delivered";

      // Emit NotificationFired on the lifecycle bus once per delivered
      // channel. SSE subscribers (e.g. Mac-side `nexus-mac` listener)
      // dispatch on the channel name. The event is signal-only — the Mac
      // listener performs synthesis locally via NexusShared.ElevenLabsClient
      // + Keychain (swift-owns-elevenlabs-synth).
      //
      // `items` + `logPath` (adopt-reaper-into-nx-cron) are threaded from
      // the caller's `extras` argument — transient transport-only fields
      // that don't live on the persisted row.
      for (const { channel } of delivered) {
        lifecycleBus.emit("NotificationFired", {
          id: notification.id,
          title: notification.title,
          body: notification.body,
          channel,
          project: notification.project ?? undefined,
          message: notification.body, // back-compat alias
          items: extras?.items,
          logPath: extras?.logPath,
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

  /**
   * Persist synthesised MP3 bytes for a notification row and stamp the
   * row's `audio_path` + `voice_used` columns (notifications-overhaul,
   * task 2.2).
   *
   * Called either by an in-process agent-side synthesiser, or by the
   * Mac listener via a future `POST /notifications/:id/audio` upload
   * endpoint. Keeping the persistence path here (manager, not route)
   * means both upload paths converge on the same DB write. When
   * synthesis fails or TTS is disabled the row's columns remain NULL —
   * callers MUST NOT invoke this method on a failed synth.
   */
  async recordSynthesisedAudio(
    notificationId: string,
    mp3Bytes: Uint8Array | Buffer,
    voiceId: string,
  ): Promise<void> {
    const path = await writeAudio(notificationId, mp3Bytes);
    await this.db
      .update(notificationsTable)
      .set({ audioPath: path, voiceUsed: voiceId })
      .where(eq(notificationsTable.id, notificationId));
    logger.debug(
      { notificationId, voiceId, bytes: mp3Bytes.byteLength },
      "manager: persisted synthesised audio",
    );
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
