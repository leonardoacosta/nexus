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
import {
  routeNotification,
  findMatchingRule,
  routeNotificationParallel,
  decidePresenceRoute,
} from "./router";
import { lifecycleBus } from "../services/lifecycle-bus";
import { writeAudio } from "./audio-store";
import type { PresenceContext } from "./presence-context";
import type { HeldQueue } from "./held-queue";
import type { PresenceHold } from "@nexus/db";
import { fleetPresence } from "@nexus/db";
import { resolveLiveConsole } from "../services/fleet-presence";
import {
  forwardOrLocal,
  type ForwardDeps,
} from "./cross-machine-delivery";

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
  /**
   * CC custom session name (the `/rename` title) — transport-only, mirrors
   * `items` / `logPath` so no schema migration is needed (nx-20caf). Surfaced
   * on the `NotificationFired` envelope as `sessionName` for the Swift consumer
   * + statusline. Undefined when no custom title was set (graceful degrade).
   */
  sessionName?: string;
  /**
   * CC session id (transcript uuid) of the originating session. Threaded
   * transport-only (no DB column), mirrors `sessionName`. Surfaced on the
   * `NotificationFired` envelope as `sessionId` so the iOS alert push carries
   * it in `userInfo.sessionId` for tap-to-session deep-linking (mx-7i4k).
   * Undefined for non-session notifications.
   */
  sessionId?: string;
}

/**
 * Notification manager — orchestrates the lifecycle:
 * check meeting state -> buffer or route -> flush on meeting end.
 */
/**
 * Optional presence-routing collaborators (context-aware-routing, Phase 1).
 *
 * Strictly opt-in: when omitted, the manager runs the byte-identical legacy
 * meeting-state buffer path. When wired AND `presenceAwareRouting` returns
 * true, `send()` consults the rules engine and routes meeting-holds through the
 * durable `HeldQueue` instead of the in-memory buffer.
 */
export interface PresenceWiring {
  context: PresenceContext;
  heldQueue: HeldQueue;
  /** Reads the live `presence_aware_routing` flag (from notification_settings). */
  presenceAwareRouting: () => Promise<boolean> | boolean;
}

/**
 * Optional cross-machine forward collaborator (cross-machine-delivery, Phase 1.6).
 *
 * Strictly additive: when omitted (single-machine fleets, or the legacy path),
 * delivery is byte-identical to today — every notification renders locally. When
 * wired, a presence-routed `deliverTo:[mac]` notification first resolves the
 * live-console machine via `resolveLiveConsole(SELECT fleet_presence)`; when that
 * machine is a PEER, the notification is forwarded to it and NOT emitted locally.
 * When the target IS local — or the forward fails (lossless fallback) — delivery
 * proceeds locally exactly as before.
 */
export interface CrossMachineWiring {
  /** Local machine identity (agents.toml self_name via getAgentId()). */
  localMachine: string;
  /** Heartbeat TTL for the live-console resolve. */
  ttlMs: number;
  /** Forward collaborators (peer lookup + fetch + secret). */
  deps: ForwardDeps;
}

export class NotificationManager {
  private meetingState: MeetingState;
  private db: Db;
  private presence: PresenceWiring | null;
  private crossMachine: CrossMachineWiring | null;

  constructor(
    db: Db,
    meetingState?: MeetingState,
    presence?: PresenceWiring,
    crossMachine?: CrossMachineWiring,
  ) {
    this.db = db;
    this.meetingState = meetingState ?? new MeetingState();
    this.presence = presence ?? null;
    this.crossMachine = crossMachine ?? null;
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

    // Always persist to the notifications table first
    await insertNotification(this.db, row);

    // ── Presence-aware path (context-aware-routing, Phase 1) ──────────────
    // Opt-in + flag-gated. When the flag is OFF (or no presence wiring),
    // `decidePresenceRoute` short-circuits and we fall through to the
    // byte-identical legacy meeting-state buffer path below.
    if (this.presence) {
      const enabled = await this.presence.presenceAwareRouting();
      const decision = decidePresenceRoute(
        enabled,
        this.presence.context.vector(),
      );
      if (decision) {
        if (decision.hold && decision.holdUntil) {
          // Durable meeting-hold: persist to presence_holds and schedule the
          // flush. The notification row stays queued until the held batch
          // flushes (coalesced summary) — see flushHeldBatch().
          await this.presence.heldQueue.hold({
            id: row.id,
            payload: {
              title: row.title,
              body: row.body ?? undefined,
              project: row.project ?? undefined,
            },
            holdUntil: new Date(decision.holdUntil),
            reason: "rule-2-meeting",
          });
          this.presence.heldQueue.scheduleFlush(
            row.id,
            new Date(decision.holdUntil),
          );
          logger.info(
            { id: row.id, holdUntil: decision.holdUntil },
            "notification held (presence rule-2 meeting hold)",
          );
          return row;
        }
        // Cross-machine forward (Phase 1.6): a `deliverTo:[mac]` action may
        // resolve to a PEER's live console. Try the forward first; only deliver
        // locally when it returns false (local target, or lossless fallback).
        if (
          this.crossMachine &&
          decision.action.deliverTo.includes("mac") &&
          (await this.tryForwardToLiveConsole(row, extras))
        ) {
          // Peer accepted the forward — mark delivered, do NOT emit locally.
          await markNotificationDelivered(this.db, row.id);
          row.status = "delivered";
          return row;
        }
        // Deliver now per the engine's channel decision.
        await this.deliverNotification(row, extras);
        return row;
      }
    }

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

  /**
   * Flush a batch of held notifications into ONE coalesced summary
   * (context-aware-routing, Phase 1, Rule 2).
   *
   * Bedtime guard: if the flush lands while `isBedtime` is true AND the Mac is
   * NOT active, the summary is delivered SILENTLY — banner only, no TTS — so a
   * meeting that ran into bedtime does not speak into a dark room. Otherwise the
   * summary delivers banner + TTS.
   *
   * Returns the coalesced summary row that was delivered, or null when the
   * batch was empty.
   */
  async flushHeldBatch(
    holds: PresenceHold[],
    extras?: NotificationTransportExtras,
  ): Promise<NotificationRow | null> {
    if (holds.length === 0) return null;

    // Coalesce into a single summary. One held item keeps its own title;
    // multiple collapse into an "N updates" summary with each as a bullet.
    const items = holds.map((h) => h.payload.title);
    const summaryTitle =
      holds.length === 1
        ? holds[0]!.payload.title
        : `${holds.length} updates while you were in a meeting`;
    const summaryBody =
      holds.length === 1
        ? holds[0]!.payload.body ?? holds[0]!.payload.title
        : items.join("; ");

    // Bedtime + idle Mac → silent (no TTS) per the Rule 2 flush guard.
    let silent = false;
    if (this.presence) {
      const v = this.presence.context.vector();
      const isBedtime = v.isBedtime.confidence !== "unknown" && v.isBedtime.value === true;
      const macIdle = v.macActive.confidence === "unknown" || v.macActive.value !== true;
      silent = isBedtime && macIdle;
    }

    const summaryId = `held-summary-${holds[0]!.id}-${Date.now()}`;
    const summaryRow: NotificationRow = {
      id: summaryId,
      channel: silent ? "desktop" : "tts",
      title: summaryTitle,
      body: summaryBody,
      project: holds[0]!.payload.project ?? null,
      agentId: null,
      priority: "normal",
      status: "queued",
      sentAt: null,
      severity: "info",
      deliveryState: "pending",
      audioPath: null,
      voiceUsed: null,
      createdAt: new Date(),
    } as NotificationRow;

    await insertNotification(this.db, summaryRow);
    await this.deliverNotification(summaryRow, { ...extras, items });

    logger.info(
      { count: holds.length, summaryId, silent },
      "notification held-batch flushed (coalesced summary)",
    );
    return summaryRow;
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
      for (const d of delivered) {
        // Persist the agent-synth mp3 column on the DB row when the TTS
        // handler returned audio bytes. The bytes are already on disk via
        // `writeAudio()` in the handler — this just stamps the row's
        // `audio_path` + `voice_used` columns so /notifications/:id/audio
        // and dashboards can find them without re-stat()ing the dir.
        if (d.channel === "tts" && d.audioBase64 && d.voiceUsed) {
          try {
            // Decode + re-write is unnecessary — writeAudio already happened
            // inside the channel handler. We only need the column stamp.
            // Use recordSynthesisedAudio with an empty buffer would re-write;
            // instead inline the column UPDATE here, narrowly scoped.
            await this.db
              .update(notificationsTable)
              .set({
                audioPath: `${notification.id}.mp3`, // path relative to audio dir; absolute is computed by readAudioPath
                voiceUsed: d.voiceUsed,
              })
              .where(eq(notificationsTable.id, notification.id));
          } catch (err) {
            logger.warn(
              {
                id: notification.id,
                err: err instanceof Error ? err.message : String(err),
              },
              "manager: failed to stamp audio_path/voice_used columns (non-fatal)",
            );
          }
        }
        lifecycleBus.emit("NotificationFired", {
          id: notification.id,
          title: notification.title,
          body: notification.body,
          channel: d.channel,
          project: notification.project ?? undefined,
          message: notification.body, // back-compat alias
          items: extras?.items,
          logPath: extras?.logPath,
          // nx-20caf: transport-only CC custom session name. Omitted (undefined)
          // when the upstream payload had no custom title.
          sessionName: extras?.sessionName,
          // mx-7i4k: transport-only CC session id for iOS tap-to-session
          // deep-linking. Omitted for non-session notifications.
          sessionId: extras?.sessionId,
          audioBase64: d.audioBase64,
          voiceUsed: d.voiceUsed,
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
   * Resolve the live-console machine from the shared `fleet_presence` table and,
   * when it is a PEER, forward the notification there (cross-machine-delivery,
   * Phase 1.6).
   *
   * @returns `true` iff a peer accepted the forward (caller skips local emit).
   *   `false` means deliver locally — covers the local-target case and every
   *   failure mode (lossless fallback in `forwardOrLocal`). Any error resolving
   *   the fleet snapshot also returns `false` so a DB hiccup never drops a
   *   notification.
   */
  private async tryForwardToLiveConsole(
    notification: NotificationRow,
    extras?: NotificationTransportExtras,
  ): Promise<boolean> {
    const cm = this.crossMachine;
    if (!cm) return false;

    try {
      const rows = await this.db.select().from(fleetPresence);
      const target = resolveLiveConsole(rows, cm.localMachine, cm.ttlMs);
      return await forwardOrLocal(
        {
          id: notification.id,
          title: notification.title,
          body: notification.body ?? "",
          channel: notification.channel,
          project: notification.project ?? undefined,
          items: extras?.items,
          logPath: extras?.logPath,
          sessionName: extras?.sessionName,
          sessionId: extras?.sessionId,
        },
        target,
        cm.localMachine,
        cm.deps,
      );
    } catch (err) {
      logger.warn(
        {
          id: notification.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "cross-machine: live-console resolve failed — delivering locally",
      );
      return false;
    }
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
