import { logger } from "@nexus/core";
import { startServer, healthCollector } from "./server";
import { createWatcherBridge } from "./watcher-bridge";
import { createSessionManager } from "./session-manager";
import { openDatabase } from "./db/database";
import { HealthScheduler } from "./health-scheduler";
import { scheduleRetention } from "./db/retention";

let db: ReturnType<typeof openDatabase>;
try {
  db = openDatabase();
} catch (err) {
  logger.error("Failed to open database — agent cannot start", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
}
const server = startServer(undefined, db);
const sessionManager = createSessionManager();

// Health snapshot scheduler — persists metrics to PostgreSQL every 30s
const healthScheduler = new HealthScheduler(healthCollector, db);
healthScheduler.start();

// Retention cleanup — prunes old snapshots/events every 24h
const stopRetention = scheduleRetention(db);

let watcherBridge: ReturnType<typeof createWatcherBridge> | null = null;

try {
  watcherBridge = createWatcherBridge({
    onEvent: (event) => sessionManager.handleWatcherEvent(event),
  });
  logger.info("watcher bridge started");
} catch (err) {
  // Watcher binary not found — agent still runs, just without session detection
  logger.warn("watcher bridge unavailable, session detection disabled", {
    error: err instanceof Error ? err.message : String(err),
  });
}

function shutdown() {
  logger.info("shutting down nexus-agent");
  healthScheduler.stop();
  stopRetention();
  sessionManager.stop();
  watcherBridge?.shutdown();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
