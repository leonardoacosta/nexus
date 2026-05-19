/**
 * Public types for the Unix domain socket server.
 *
 * Split from socket-server.ts so handler types can be imported without
 * pulling in the full server runtime (dispatcher, Bun listener, etc).
 */

import type { Db } from "@nexus/db";
import type { SocketEvent, SocketCommand, SocketResponse } from "../../types/socket-events";
import type { SessionManager } from "../../session-manager";
import type { LifecycleBus } from "../lifecycle-bus";

// ---------------------------------------------------------------------------
// Event / command handler types
// ---------------------------------------------------------------------------

export type SocketEventHandler = (event: SocketEvent) => void | Promise<void>;
export type SocketCommandHandler = (command: SocketCommand) => SocketResponse | Promise<SocketResponse>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SocketServer {
  /** Stop the server and remove the socket file. */
  stop(): void;
  /** The resolved socket path. */
  readonly path: string;
  /**
   * Liveness — true while the underlying `Bun.listen` is bound and accepting
   * new connections. False after `stop()` has been called, or when the
   * initial bind failed. Read by `GET /health.socket_server_listening`.
   */
  isListening(): boolean;
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
// Dispatcher dependencies
// ---------------------------------------------------------------------------

export interface SocketDispatchDeps {
  sessionManager: SessionManager;
  lifecycleBus: LifecycleBus;
  /** Optional DB for credential lookup during session-credential binding. */
  db?: Db;
}
