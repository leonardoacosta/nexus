/**
 * Federation → Notification bridge
 *
 * Subscribes to peer-sourced lifecycle events on the bus and routes
 * relevant ones through the notification router (TTS/desktop/slack).
 *
 * Only events with `source: 'peer'` are processed. Local events are
 * already handled by their originating subsystems.
 */

import { createLogger } from "@nexus/core/node";
import {
  lifecycleBus,
  type LifecycleEnvelope,
} from "./lifecycle-bus";
import { routeNotificationParallel } from "../notifications/router";
import { isUnspeakable } from "../notifications/speakability";
import type { NotificationRow } from "../notifications/buffer";

const log = createLogger("agent:federation-notify");

/** Convert a peer lifecycle event into a notification and route it. */
async function handlePeerEvent(envelope: LifecycleEnvelope): Promise<void> {
  // Only process peer-sourced events
  if (envelope.source !== "peer") return;

  let title: string;
  let body: string;
  let project: string | null = null;

  switch (envelope.event) {
    case "SessionStarted": {
      const p = envelope.payload as { sessionId: string; project?: string; model?: string };
      title = "Session Started";
      body = `Session ${p.sessionId} started${p.project ? ` in ${p.project}` : ""}${envelope.origin ? ` on ${envelope.origin}` : ""}`;
      project = p.project ?? null;
      break;
    }
    case "SessionStopped": {
      const p = envelope.payload as { sessionId: string };
      title = "Session Stopped";
      body = `Session ${p.sessionId} ended${envelope.origin ? ` on ${envelope.origin}` : ""}`;
      break;
    }
    case "SpecTransition": {
      const p = envelope.payload as { project: string; specName: string; transition: string; completed?: number; total?: number };
      title = "Spec Transition";
      project = p.project;
      if (p.transition === "all_complete") {
        body = `${p.project}: ${p.specName} all tasks complete${envelope.origin ? ` (${envelope.origin})` : ""}`;
      } else if (p.transition === "progress" && p.completed !== undefined && p.total !== undefined) {
        body = `${p.project}: ${p.specName} ${p.completed}/${p.total}${envelope.origin ? ` (${envelope.origin})` : ""}`;
      } else {
        body = `${p.project}: ${p.specName} — ${p.transition}${envelope.origin ? ` (${envelope.origin})` : ""}`;
      }
      break;
    }
    case "NotificationFired": {
      const p = envelope.payload as { message: string; channel: string; project?: string };
      title = "Peer Notification";
      body = `${envelope.origin ?? "peer"}: ${p.message}`;
      project = p.project ?? null;
      break;
    }
    default:
      // Don't route heartbeats, status changes, or credential swaps
      return;
  }

  // Bodies that read like raw file paths (cross-machine screenshot paths,
  // hashes, etc.) get downgraded to desktop so the Mac listener doesn't
  // read them aloud.
  const channel = isUnspeakable(body) ? "desktop" : "tts";
  if (channel === "desktop") {
    log.info(
      { origin: envelope.origin, body },
      "federation-notify: TTS suppressed for unspeakable body — routing to desktop",
    );
  }

  // Build a stub notification row for the router
  const notification: NotificationRow = {
    id: `fed-${envelope.origin ?? "peer"}-${envelope.seq}-${Date.now()}`,
    title,
    body,
    channel,
    priority: "normal",
    status: "queued",
    project,
    // Federation notifications are cross-agent broadcasts — no owning local agent.
    agentId: null,
    createdAt: new Date(),
    sentAt: null,
  };

  try {
    const result = await routeNotificationParallel(notification);
    if (result.failed.length > 0) {
      log.warn(
        { failed: result.failed, event: envelope.event },
        "federation-notify: some channels failed",
      );
    }
  } catch (err) {
    log.error(
      { error: err, event: envelope.event },
      "federation-notify: routing failed",
    );
  }
}

let subscribed = false;

/** Start listening to peer events and routing notifications. */
export function startFederationNotify(): void {
  if (subscribed) return;
  subscribed = true;
  lifecycleBus.onAny(handlePeerEvent);
  log.info("federation-notify: started");
}

/** Stop listening (for tests / shutdown). */
export function stopFederationNotify(): void {
  if (!subscribed) return;
  subscribed = false;
  lifecycleBus.offAny(handlePeerEvent);
  log.info("federation-notify: stopped");
}
