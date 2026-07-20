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
import type { NotificationManager } from "../../notifications/manager";
import type { CredentialPool } from "../../credentials/pool";

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
  /**
   * Lazy accessor for the shared `NotificationManager` singleton (nx-f060f).
   * Threaded as a getter (not the instance) because the manager is created
   * asynchronously by `initNotificationRoutes` and may still be `null` at the
   * time the dispatcher is constructed (`index.ts` builds the dispatcher
   * before the fire-and-forget init resolves). The dispatcher resolves it at
   * dispatch time so a `session_stop` crash fires a notification once the
   * manager is ready. Omitted in unit tests that don't exercise the notify
   * path — the dispatcher no-ops when the accessor is absent or returns null.
   */
  getNotificationManager?: () => NotificationManager | null;
  /**
   * Lazy accessor for the shared `CredentialPool` singleton (wire-reactive-
   * rate-limit-swap, task 2.2). Same lazy-getter shape as
   * `getNotificationManager` — the pool is created asynchronously by
   * `initCredentialRoutes` and may still be null when the dispatcher is
   * constructed. Omitted in unit tests that don't exercise the reactive
   * rate-limit swap path — that path no-ops (falls through to normal
   * delivery) when the accessor is absent or returns null.
   */
  getCredentialPool?: () => CredentialPool | null;
}
