/**
 * Socket event dispatch -- routes SocketEvent types to the appropriate
 * subsystems (SessionManager, notification router, etc).
 *
 * This module bridges the socket server's raw events to existing agent
 * infrastructure:
 * - SessionStart/Stop/Heartbeat -> SessionManager (via WatcherEvent mapping)
 * - Notification -> notification router (TTS/desktop/slack channels)
 * - AgentSpawn/AgentComplete/Telemetry/SessionSummary/DeployStatus -> logged
 *
 * The socket dispatch layer deduplicates with the watcher bridge by using
 * the same SessionManager.handleWatcherEvent() path.
 */

import { createLogger } from "@nexus/core";
import type { WatcherEvent } from "@nexus/core";
import type { SessionManager } from "../session-manager";
import type { SocketEvent } from "../types/socket-events";
import { recordNotification } from "./command-handler";
import { sendTtsNotification } from "../notifications/channels/tts";
import { lifecycleBus } from "./lifecycle-bus";

const log = createLogger("agent:socket-dispatch");

export interface SocketDispatchOptions {
  sessionManager: SessionManager;
}

/**
 * Create a socket event handler that dispatches events to the appropriate
 * subsystems.
 */
export function createSocketEventHandler(
  options: SocketDispatchOptions,
): (event: SocketEvent) => void {
  const { sessionManager } = options;

  return function dispatchEvent(event: SocketEvent): void {
    switch (event.event) {
      case "session_start": {
        // Map to WatcherEvent and route through SessionManager.
        const watcherEvent: WatcherEvent = {
          type: "session_start",
          session_id: event.session_id,
          project: event.project ?? "",
          path: event.cwd ?? "",
        };
        sessionManager.handleWatcherEvent(watcherEvent);
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
