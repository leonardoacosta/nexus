/**
 * nexus-agent HTTP + WebSocket server entry point.
 *
 * This file has been slimmed down to just the `startServer()` function plus
 * backward-compat re-exports. The bulk of the logic lives in sibling modules:
 *
 * - server-websocket.ts          — ServerState, WS upgrade, WS handlers
 * - server-origin.ts             — isTailscaleOrigin, isDisallowedBrowserOrigin, withCors
 * - server-auth.ts               — ATTACH_SECRET, requireSecret, CREDENTIAL_ID_RE
 * - server-state.ts              — _singletonState + healthCollector/streamManager exports
 * - server-health-handler.ts     — /health + /health/ingest handlers
 * - server-request-handler.ts    — createRequestHandler (main HTTP dispatcher)
 * - server-routes-credentials.ts — /credentials/* sub-dispatcher
 * - server-routes-specs.ts       — /specs/*, /commands/* sub-dispatchers
 */

import type { Db } from "@nexus/db";
import { logger } from "@nexus/core/node";
import { initNotificationRoutes } from "./routes/notifications";
import { initCredentialRoutes, getCredentialPool } from "./routes/credentials";
import {
  startCredentialWatcher,
  startActiveCredentialWatcher,
} from "./credentials/credential-watcher";
import { initCommandRoutes } from "./routes/commands";
import { initConfigLoader } from "./services/config-loader";
import type { WsData } from "./terminal/stream-manager";
import { safeFireAndForget } from "./utils/safe-fire-and-forget";
import type { AppContext } from "./context";
import { createWsHandlers } from "./server-websocket";
import { _singletonState } from "./server-state";
import { createRequestHandler } from "./server-request-handler";

// ── Backward-compat re-exports ──────────────────────────────────────────────
// Test files and downstream code import these directly from ./server.
export { ServerState } from "./server-websocket";
export { healthCollector, streamManager } from "./server-state";

const PORT = 7400;

export function startServer(
  port: number = PORT,
  db?: Db,
  options?: { encryptionKey?: import("node:buffer").Buffer; prerotateThreshold?: number },
  _ctx?: AppContext,
) {
  // Use the module singleton state so that module-level `healthCollector` and
  // `streamManager` exports remain valid references to the running server's state.
  const state = _singletonState;

  // Initialize subsystems that need the DB.
  // initNotificationRoutes is async (mutex-guarded) — fire-and-forget here
  // since server startup itself is synchronous and the manager will be ready
  // well before the first real request arrives.
  if (db) {
    safeFireAndForget(initNotificationRoutes(db), "init-notification-routes");
    initCredentialRoutes(db, {
      encryptionKey: options?.encryptionKey,
      prerotateThreshold: options?.prerotateThreshold,
    });

    // Refresh credential metadata from disk (expiresAt, mcpProviders, etc.)
    // Fire-and-forget — stale metadata doesn't block server startup.
    const pool = getCredentialPool();
    if (pool) {
      safeFireAndForget(pool.refreshMetadata(), "credential-metadata-refresh");
      // Watch credential directory for new/changed files
      startCredentialWatcher(pool);
      // Watch ~/.claude/.credentials.json symlink for active-account tracking
      startActiveCredentialWatcher(pool);
    }
  }

  // Initialize subsystems that do not need the DB.
  initConfigLoader();
  initCommandRoutes();

  const handler = createRequestHandler(state, db);

  const server = Bun.serve<WsData>({
    port,
    // SSE streams (e.g. /events/stream, /specs/events) hold connections open
    // for minutes-to-hours with sparse keepalive frames. Bun's default
    // idleTimeout is 10s, which silently closes those streams ~10s after the
    // last byte. 255s (the maximum) is well past the longest keepalive
    // interval (30s) used by any handler. See nx-4p8n.
    idleTimeout: 255,
    fetch(req, server) {
      return handler(req, server);
    },
    websocket: createWsHandlers(state),
  });

  logger.info({ port: server.port }, "nexus-agent started");
  return server;
}
