/**
 * Unix domain socket server lifecycle.
 *
 * Resolves the socket path, cleans up stale sockets, binds a Bun listener,
 * and dispatches newline-delimited JSON lines as SocketEvents or
 * SocketCommands to the handlers supplied by the caller.
 */

import { existsSync, unlinkSync } from "node:fs";
import { createLogger } from "@nexus/core/node";
import type { Socket } from "bun";
import type { SocketCommand, SocketResponse } from "../../types/socket-events";
import { isSocketEvent, isSocketCommand } from "../../types/socket-events";
import type {
  SocketCommandHandler,
  SocketEventHandler,
  SocketServer,
  SocketServerOptions,
} from "./types";

const log = createLogger("agent:socket-server");

const DEFAULT_SOCKET_PATH = "/tmp/nexus-agent.sock";

// ---------------------------------------------------------------------------
// Socket connection data
// ---------------------------------------------------------------------------

interface SocketData {
  lineBuffer: string;
  eventHandler: SocketEventHandler;
  commandHandler: SocketCommandHandler;
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
