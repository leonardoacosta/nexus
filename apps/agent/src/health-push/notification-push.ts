// notification-push.ts — bridges the in-process `NotificationFired` lifecycle
// event to a VISIBLE iOS alert push (lock-screen banner / Notification Center).
//
// WHY: before this, the agent only ever sent SILENT (background) pushes via
// `health-push-scheduler` → `ApnsSender.sendHealthFlush`, and the iOS app's
// `didReceiveRemoteNotification` ignores everything except `nexusKind ==
// "health-flush"`. Notification text only reached SSE listeners, so NO visible
// push ever landed on the phone. This subscriber closes that gap: every
// NotificationFired fans out an `aps.alert` push (priority 10, push-type alert)
// to every registered iOS token. iOS renders these with no app-side handling;
// taps route via `userInfo.sessionId` (existing NexusAppDelegate behaviour).
//
// Inert (no-op) when no APNs key (sender null) or no registered tokens —
// mirrors `health-push-scheduler`. Dead tokens (410 / Unregistered /
// BadDeviceToken) are pruned from the store, like a well-behaved APNs client.

import { createLogger } from "@nexus/core/node";
import { getApnsSender } from "./apns-sender";
import { getDeviceTokenStore } from "./device-token-store";
import type { LifecycleBus, NotificationFiredPayload } from "../services/lifecycle-bus";

const log = createLogger("agent:health-push:notify");

/**
 * Subscribes to `NotificationFired` and sends one visible alert push per
 * notification to all registered iOS device tokens.
 *
 * NOTE: the lifecycle bus emits `NotificationFired` ONCE PER DELIVERED CHANNEL
 * (e.g. a notification delivered to both `desktop` and `tts` fires twice). We
 * dedup by the notification `id` so a single user-facing notification produces
 * exactly one banner push, not one per channel.
 */
export class NotificationPushSubscriber {
  private readonly bus: LifecycleBus;
  private started = false;
  // Bounded LRU-ish set of recently-pushed notification ids (dedup across the
  // per-channel double-emit). A plain Set with periodic trim keeps it O(1) and
  // memory-bounded — notification ids are short-lived idempotency keys.
  private readonly recent = new Set<string>();
  private static readonly RECENT_CAP = 512;

  constructor(bus: LifecycleBus) {
    this.bus = bus;
  }

  start(): void {
    if (this.started) return;
    const sender = getApnsSender();
    if (!sender) {
      log.warn(
        "no APNs sender (key missing) — notification alert-push subscriber not started",
      );
      return;
    }
    this.started = true;
    this.bus.on("NotificationFired", (env) => {
      void this.handle(env.payload);
    });
    log.info("notification alert-push subscriber started");
  }

  private async handle(p: NotificationFiredPayload): Promise<void> {
    // Dedup: one banner per notification id, regardless of channel fan-out.
    if (this.recent.has(p.id)) return;
    this.recent.add(p.id);
    if (this.recent.size > NotificationPushSubscriber.RECENT_CAP) {
      // Trim oldest ~half — Set preserves insertion order.
      let drop = this.recent.size - NotificationPushSubscriber.RECENT_CAP / 2;
      for (const id of this.recent) {
        if (drop-- <= 0) break;
        this.recent.delete(id);
      }
    }

    try {
      const sender = getApnsSender();
      if (!sender) return;
      const store = getDeviceTokenStore();
      const tokens = await store.all();
      if (tokens.length === 0) return;

      const title = this.title(p);
      const body = p.body || p.message || title;
      const userInfo: Record<string, unknown> = {
        notificationId: p.id,
      };
      // sessionId is what the iOS tap-router (NexusAppDelegate) keys on to
      // deep-link the banner tap to the originating session's detail view
      // (mx-7i4k). Present for session-originated notifications; absent for
      // non-session ones (e.g. reaper stale-heartbeat), in which case the iOS
      // app falls back to opening its default view (graceful).
      if (p.project) userInfo.project = p.project;
      if (p.sessionName) userInfo.sessionName = p.sessionName;
      if (p.sessionId) userInfo.sessionId = p.sessionId;

      let ok = 0;
      for (const t of tokens) {
        const { status, reason } = await sender.sendAlert(t.token, {
          title,
          body,
          userInfo,
        });
        if (status === 200) {
          ok++;
        } else if (
          status === 410 ||
          reason === "BadDeviceToken" ||
          reason === "Unregistered"
        ) {
          await store.remove(t.token);
          log.info(`pruned dead token (status=${status} reason=${reason})`);
        } else {
          log.warn(`alert push failed (status=${status} reason=${reason ?? "?"})`);
        }
      }
      if (ok > 0) {
        log.info(
          `alert push sent to ${ok}/${tokens.length} device(s) (id=${p.id} title="${title}" sessionId=${p.sessionId ?? "none"})`,
        );
      }
    } catch (e) {
      log.warn(`notification alert-push error: ${(e as Error).message}`);
    }
  }

  /** Concise banner title: prefer the CC session name, then project, then the
   *  notification's own title, then a generic fallback. */
  private title(p: NotificationFiredPayload): string {
    return p.sessionName || p.project || p.title || "Nexus";
  }
}

let _subscriber: NotificationPushSubscriber | null = null;
export function getNotificationPushSubscriber(
  bus: LifecycleBus,
): NotificationPushSubscriber {
  if (!_subscriber) _subscriber = new NotificationPushSubscriber(bus);
  return _subscriber;
}
