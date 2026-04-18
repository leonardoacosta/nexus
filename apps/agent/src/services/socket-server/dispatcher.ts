/**
 * Built-in socket event dispatcher.
 *
 * Replaces the former socket-dispatch intermediary layer: consumes
 * SocketEvents and fans them out to the SessionManager, LifecycleBus,
 * notification history, and TTS channel.
 */

import { createLogger } from "@nexus/core/node";
import type { WatcherEvent } from "@nexus/core";
import type { Db } from "@nexus/db";
import { credentials, eq } from "@nexus/db";
import type { SocketEvent } from "../../types/socket-events";
import type { SessionManager } from "../../session-manager";
import { recordNotification } from "../command-handler";
import { sendTtsNotification } from "../../notifications/channels/tts";
import type { SocketDispatchDeps, SocketEventHandler } from "./types";

const log = createLogger("agent:socket-server");

/**
 * Create the default socket event handler that dispatches events directly
 * to the lifecycle bus and session manager. This replaces the former
 * socket-dispatch intermediary layer.
 */
export function createSocketEventDispatcher(
  deps: SocketDispatchDeps,
): SocketEventHandler {
  const { sessionManager, lifecycleBus, db } = deps;

  return function dispatchEvent(event: SocketEvent): void {
    switch (event.event) {
      case "session_start": {
        const watcherEvent: WatcherEvent = {
          type: "session_start",
          session_id: event.session_id,
          project: event.project ?? "",
          path: event.cwd ?? "",
        };
        sessionManager.handleWatcherEvent(watcherEvent);

        // Best-effort credential binding: if the event includes a
        // credential fingerprint, look up the credential and populate
        // credentialId + credentialFingerprint on the session.
        if (event.credential_fingerprint && db) {
          bindSessionCredential(
            sessionManager,
            db,
            event.session_id,
            event.credential_fingerprint,
          ).catch((err: unknown) => {
            log.warn(
              { error: err, sessionId: event.session_id },
              "socket: credential binding failed (best-effort)",
            );
          });
        }

        lifecycleBus.emit("SessionStarted", {
          sessionId: event.session_id,
          project: event.project,
          cwd: event.cwd,
          model: event.model,
        });
        log.info(
          {
            sessionId: event.session_id,
            project: event.project,
            model: event.model,
            credentialFingerprint: event.credential_fingerprint ?? null,
          },
          "socket: session_start",
        );
        break;
      }

      case "session_stop": {
        const watcherEvent: WatcherEvent = {
          type: "session_end",
          session_id: event.session_id,
        };
        sessionManager.handleWatcherEvent(watcherEvent);
        lifecycleBus.emit("SessionStopped", {
          sessionId: event.session_id,
        });
        log.info({ sessionId: event.session_id }, "socket: session_stop");
        break;
      }

      case "session_heartbeat": {
        const watcherEvent: WatcherEvent = {
          type: "session_update",
          session_id: event.session_id,
          timestamp: new Date().toISOString(),
        };
        sessionManager.handleWatcherEvent(watcherEvent);
        lifecycleBus.emit("SessionHeartbeat", {
          sessionId: event.session_id,
          timestamp: new Date().toISOString(),
        });
        log.debug({ sessionId: event.session_id }, "socket: session_heartbeat");
        break;
      }

      case "notification": {
        const effectiveChannels = event.channels ?? ["tts"];
        const messageType = event.message_type ?? "brief";

        log.info(
          {
            message: event.message,
            messageType,
            channels: effectiveChannels,
            hasQuestion: !!event.question,
          },
          "socket: notification",
        );

        // Record in history for the `history` command.
        recordNotification(event.message, messageType, effectiveChannels);

        // Emit to lifecycle bus for federation
        lifecycleBus.emit("NotificationFired", {
          message: event.message,
          channel: effectiveChannels.join(","),
        });

        // Route to TTS if TTS is in the channels list.
        if (effectiveChannels.includes("tts")) {
          const stubRow = {
            id: `socket-notif-${Date.now()}`,
            title: "Notification",
            body: event.message,
            channel: "tts" as const,
            priority: "normal" as const,
            status: "queued" as const,
            project: null,
            // Socket event router has no agent context; pass null (global).
            agentId: null,
            createdAt: new Date(),
            sentAt: null,
          };
          sendTtsNotification(stubRow).catch((err: unknown) => {
            log.warn({ error: err }, "socket: TTS notification failed");
          });
        }
        break;
      }

      case "answer": {
        log.info(
          {
            textLen: event.text.length,
            sessionId: event.session_id,
          },
          "socket: answer (not yet wired to tmux dispatch)",
        );
        break;
      }

      case "agent_spawn": {
        log.info(
          {
            sessionId: event.session_id,
            agentType: event.agent_type,
            model: event.model,
          },
          "socket: agent_spawn",
        );
        break;
      }

      case "agent_complete": {
        log.info(
          {
            sessionId: event.session_id,
            agentType: event.agent_type,
            durationMs: event.duration_ms,
          },
          "socket: agent_complete",
        );
        break;
      }

      case "telemetry": {
        log.debug(
          { keys: Object.keys(event.payload) },
          "socket: telemetry",
        );
        break;
      }

      case "session_summary": {
        log.info(
          {
            sessionId: event.session_id,
            project: event.project,
            toolCount: Object.keys(event.tool_counts ?? {}).length,
            failureCount: event.failure_count,
            durationMs: event.duration_ms,
          },
          "socket: session_summary",
        );
        break;
      }

      case "deploy_status": {
        const target = event.target ?? "local";
        const service = event.service ?? "unknown";
        log.info(
          {
            project: event.project,
            status: event.status,
            target,
            service,
          },
          "socket: deploy_status",
        );
        break;
      }

      default: {
        log.warn({ event }, "socket: unknown event type");
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort credential binding for a session.
 *
 * Looks up the credential by fingerprint and mutates the in-memory session
 * with `credentialId` and `credentialFingerprint`. The session manager's
 * write-through will persist the update on the next upsert cycle, but we
 * also trigger an explicit upsert to ensure the DB row is updated promptly.
 *
 * Never throws — callers should `.catch()` to avoid unhandled rejections.
 */
async function bindSessionCredential(
  sessionManager: SessionManager,
  db: Db,
  sessionId: string,
  fingerprint: string,
): Promise<void> {
  const session = sessionManager.getById(sessionId);
  if (!session) {
    log.debug({ sessionId }, "socket: credential binding skipped — session not found in cache");
    return;
  }

  // Always store the fingerprint, even if we can't resolve the credential ID.
  session.credentialFingerprint = fingerprint;

  // Look up the credential by fingerprint.
  const rows = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(eq(credentials.fingerprint, fingerprint))
    .limit(1);

  if (rows.length > 0 && rows[0]) {
    session.credentialId = rows[0].id;
    log.info(
      { sessionId, credentialId: rows[0].id, fingerprint },
      "socket: session bound to credential",
    );
  } else {
    log.debug(
      { sessionId, fingerprint },
      "socket: no credential found for fingerprint — credentialId stays null",
    );
  }

  // Trigger an explicit write-through to persist the binding.
  // Import upsertSession to avoid coupling to session-manager internals.
  const { upsertSession } = await import("../../db/sessions");
  await upsertSession(db, session);
}
