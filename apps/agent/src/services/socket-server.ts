/**
 * Unix domain socket server for JSON event ingestion.
 *
 * Implementation split across `socket-server/` subdirectory:
 * - types.ts      — handler types + public interfaces
 * - dispatcher.ts — createSocketEventDispatcher + credential binding
 * - server.ts     — startSocketServer + resolveSocketPath + cleanupStaleSocket
 *
 * This barrel preserves the existing `./socket-server` import path.
 */

export * from "./socket-server/index";
