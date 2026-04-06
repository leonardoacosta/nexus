import "./instrument";
import { logger } from "@nexus/core";
import { startServer, healthCollector, streamManager } from "./server";
import { createWatcherBridge } from "./watcher-bridge";
import { createSessionManager } from "./session-manager";
import { openDatabase } from "./db/database";
import { upsertSelfInRegistry } from "./db/agent-registry";
import { HealthScheduler } from "./health-scheduler";
import { scheduleRetention } from "./db/retention";
import { loadEncryptionKey, loadPrerotateThreshold } from "./credentials/encryption";

// ── Encryption key validation (fail-fast) ───────────────────────────────────
let encryptionKey: ReturnType<typeof loadEncryptionKey>;
let prerotateThreshold: number;
try {
  encryptionKey = loadEncryptionKey();
  prerotateThreshold = loadPrerotateThreshold();
} catch (err) {
  logger.error(
    { error: err instanceof Error ? err.message : String(err) },
    "Encryption key validation failed — agent cannot start",
  );
  process.exit(1);
}

let db: ReturnType<typeof openDatabase>;
try {
  db = openDatabase();
} catch (err) {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to open database — agent cannot start");
  process.exit(1);
}
const server = startServer(undefined, db, { encryptionKey, prerotateThreshold });

// Register this agent in the DB (non-fatal — agent still serves if this fails)
upsertSelfInRegistry(db).catch((err) => {
  logger.warn({ error: err instanceof Error ? err.message : String(err) }, "agent self-registration failed — will retry on next restart");
});

logger.info({ queryWindowHours: 24 }, "Project discovery query window configured");

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
  logger.warn({ error: err instanceof Error ? err.message : String(err) }, "watcher bridge unavailable, session detection disabled");
}

function shutdown() {
  logger.info("shutting down nexus-agent");
  healthScheduler.stop();
  stopRetention();
  sessionManager.stop();
  watcherBridge?.shutdown();
  // Task 1.4: Shut down all active PTY streams before stopping the HTTP server
  streamManager.shutdown();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
