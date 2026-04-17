/**
 * Module-level singleton ServerState + compatibility exports.
 *
 * These are re-exported from server.ts for backward compat. Code that imports
 * `healthCollector` or `streamManager` directly from server.ts gets the
 * singleton's instances (the server started by `startServer()`).
 *
 * Test files that need full isolation should call `ServerState.create()` and
 * pass the resulting state to a custom `createRequestHandler` / Bun.serve call.
 */

import { ServerState } from "./server-websocket";

/**
 * Shared ServerState instance used by `startServer()` and the module-level
 * `healthCollector` / `streamManager` exports.
 */
export const _singletonState = ServerState.create();

/**
 * Module-level healthCollector export (singleton).
 * Maintained for backward compat with server.test.ts.
 */
export const healthCollector = _singletonState.healthCollector;

/**
 * Module-level streamManager export (singleton).
 * Maintained for backward compat with server.test.ts.
 */
export const streamManager = _singletonState.streamManager;
