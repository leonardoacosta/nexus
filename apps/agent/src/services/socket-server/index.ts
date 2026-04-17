/**
 * Unix domain socket server for JSON event ingestion.
 *
 * CC hooks write newline-delimited JSON to `/tmp/nexus-agent.sock`
 * (configurable via `NEXUS_SOCKET`). This barrel re-exports the full
 * public surface split across types.ts, dispatcher.ts, and server.ts.
 */

export type {
  SocketCommandHandler,
  SocketDispatchDeps,
  SocketEventHandler,
  SocketServer,
  SocketServerOptions,
} from "./types";
export { createSocketEventDispatcher } from "./dispatcher";
export {
  cleanupStaleSocket,
  resolveSocketPath,
  startSocketServer,
} from "./server";
