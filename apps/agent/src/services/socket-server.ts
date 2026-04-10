/**
 * Unix domain socket server for JSON event ingestion.
 *
 * CC hooks write newline-delimited JSON to `/tmp/nexus-agent.sock`
 * (configurable via `NEXUS_SOCKET`). This module:
 *
 * 1. Resolves and validates the socket path (stale-socket cleanup).
 * 2. Binds a Unix socket listener and accepts connections.
 * 3. Reads lines and dispatches events to registered handlers.
 * 4. Handles SocketCommand messages by writing a JSON response back.
 * 5. Shuts down cleanly, removing the socket file.
 */

import { existsSync, unlinkSync } from "node:fs";
import { createLogger } from "@nexus/core";
import type { WatcherEvent } from "@nexus/core";
import type { Socket } from "bun";
import type { SocketEvent, SocketCommand, SocketResponse } from "../types/socket-events";
import { isSocketEvent, isSocketCommand } from "../types/socket-events";
import type { SessionManager } from "../session-manager";
import type { LifecycleBus } from "./lifecycle-bus";
import { recordNotification } from "./command-handler";
import { sendTtsNotification } from "../notifications/channels/tts";

const log = createLogger("agent:socket-server");

const DEFAULT_SOCKET_PATH = "/tmp/nexus-agent.sock";

// ---------------------------------------------------------------------------
// Event / command handler types
// ---------------------------------------------------------------------------

export type SocketEventHandler = (event: SocketEvent) => void | Promise<void>;
export type SocketCommandHandler = (command: SocketCommand) => SocketResponse | Promise<SocketResponse>;

// ---------------------------------------------------------------------------
// Socket connection data
// ---------------------------------------------------------------------------

interface SocketData {
  lineBuffer: string;
  eventHandler: SocketEventHandler;
  commandHandler: SocketCommandHandler;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SocketServer {
  /** Stop the server and remove the socket file. */
  stop(): void;
  /** The resolved socket path. */
  readonly path: string;
}

export interface SocketServerOptions {
  /** Handler for fire-and-forget events (SessionStart, Notification, etc). */
  onEvent: SocketEventHandler;
  /** Handler for request/response commands (ModeQuery, History, etc). */
  onCommand: SocketCommandHandler;
  /** Override the socket path (default: /tmp/nexus-agent.sock or NEXUS_SOCKET). */
  socketPath?: string;
}

// ---------------------------------------------------------------------------
// Built-in event dispatcher (replaces socket-dispatch.ts)
// ---------------------------------------------------------------------------

export interface SocketDispatchDeps {
  sessionManager: SessionManager;
  lifecycleBus: LifecycleBus;
}

/**
 * Create the default socket event handler that dispatches events directly
 * to the lifecycle bus and session manager. This replaces the former
 * socket-dispatch intermediary layer.
 */
export function createSocketEventDispatcher(
  deps: SocketDispatchDeps,
): SocketEventHandler {
  const { sessionManager, lifecycleBus } = deps;

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

/** Resolve the socket path from env or default. */
export function resolveSocketPath(): string {
  return process.env.NEXUS_SOCKET ?? DEFAULT_SOCKET_PATH;
}

/**
 * Remove a stale socket file if it exists and no process is listening.
 *
 * If the socket exists and a connection attempt succeeds, another instance
 * is running and an error is thrown. If the connection fails, the socket
 * is stale and is removed.
 */
export async function cleanupStaleSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;

  // Try to connect — if it succeeds, another instance is running.
  try {
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data() {},
        open(socket) {
          socket.end();
        },
        error() {},
        close() {},
      },
    });
    // Connection succeeded — another instance is running.
    socket.end();
    throw new Error(
      `socket ${path} already in use -- another nexus-agent instance is running`,
    );
  } catch (err) {
    // If it's our own error, rethrow.
    if (err instanceof Error && err.message.includes("already in use")) {
      throw err;
    }
    // Connection failed — socket is stale, remove it.
    log.warn({ path }, "removing stale socket");
    try {
      unlinkSync(path);
    } catch (unlinkErr) {
      log.error({ path, error: unlinkErr }, "failed to remove stale socket");
      throw unlinkErr;
    }
  }
}

/**
 * Start the Unix domain socket server.
 *
 * Protocol:
 * - Each connection reads newline-delimited JSON.
 * - Each line is tried first as a SocketEvent (fire-and-forget).
 * - Then as a SocketCommand (request/response: JSON reply, then close).
 * - Multiple events can arrive on the same stream before EOF.
 */
export async function startSocketServer(
  options: SocketServerOptions,
): Promise<SocketServer> {
  const socketPath = options.socketPath ?? resolveSocketPath();

  // Clean up stale socket before binding.
  await cleanupStaleSocket(socketPath);

  const server = Bun.listen<SocketData>({
    unix: socketPath,
    socket: {
      open(socket: Socket<SocketData>) {
        socket.data = {
          lineBuffer: "",
          eventHandler: options.onEvent,
          commandHandler: options.onCommand,
        };
        log.debug("socket: connection opened");
      },

      data(socket: Socket<SocketData>, data: Buffer) {
        const ctx = socket.data;
        ctx.lineBuffer += data.toString();

        // Process complete lines.
        const lines = ctx.lineBuffer.split("\n");
        // Keep the last incomplete chunk in the buffer.
        ctx.lineBuffer = lines.pop()!;

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            log.warn({ raw: line.slice(0, 200) }, "socket: invalid JSON");
            continue;
          }

          // Try SocketEvent first (most common path -- hooks fire-and-forget)
          if (isSocketEvent(parsed)) {
            try {
              const result = ctx.eventHandler(parsed);
              // If handler returns a promise, catch errors without blocking.
              if (result && typeof (result as Promise<void>).catch === "function") {
                (result as Promise<void>).catch((err: unknown) => {
                  log.error({ error: err, event: parsed.event }, "socket: event handler error");
                });
              }
            } catch (err) {
              log.error({ error: err, event: parsed.event }, "socket: event handler error");
            }
            continue;
          }

          // Try SocketCommand (query/mutate -- expects a JSON response)
          if (isSocketCommand(parsed)) {
            handleCommand(socket, parsed, ctx.commandHandler);
            return; // Commands are single-shot: stop reading after sending response.
          }

          log.warn(
            { raw: line.slice(0, 200) },
            "socket: unrecognised JSON (not event or command)",
          );
        }
      },

      error(_socket: Socket<SocketData>, error: Error) {
        log.error({ error: error.message }, "socket: connection error");
      },

      close() {
        log.debug("socket: connection closed");
      },
    },
  });

  log.info({ path: socketPath }, "socket listener bound");

  function stop(): void {
    log.info("socket service shutting down");
    server.stop();
    // Remove the socket file so nothing tries to connect to a dead socket.
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
        log.info({ path: socketPath }, "socket file removed");
      } catch (err) {
        log.warn({ error: err }, "failed to remove socket file on shutdown");
      }
    }
  }

  return { stop, path: socketPath };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Handle a SocketCommand: call the handler, write the JSON response, then
 * close the connection.
 */
async function handleCommand(
  socket: Socket<SocketData>,
  command: SocketCommand,
  handler: SocketCommandHandler,
): Promise<void> {
  try {
    const response = await handler(command);
    const responseLine = JSON.stringify(response) + "\n";
    socket.write(responseLine);
    socket.end();
  } catch (err) {
    const errorResponse: SocketResponse = {
      error: err instanceof Error ? err.message : String(err),
    };
    socket.write(JSON.stringify(errorResponse) + "\n");
    socket.end();
    log.error({ error: err, command: command.command }, "socket: command handler error");
  }
}
