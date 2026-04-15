import "./instrument";
import { logger } from "@nexus/core";
import { startServer, healthCollector, streamManager } from "./server";
import { createWatcherBridge } from "./watcher-bridge";
import { createSessionManager } from "./session-manager";
import { openDatabase } from "./db/database";
import { upsertSelfInRegistry } from "./db/agent-registry";
import { HealthScheduler } from "./health-scheduler";
import { scheduleRetention } from "./db/retention";
import { scheduleProjectCleanup } from "./db/project-registry";
import { loadEncryptionKey, loadPrerotateThreshold } from "./credentials/encryption";
import { startSocketServer, createSocketEventDispatcher, type SocketServer } from "./services/socket-server";
import { startCronService, type CronService } from "./services/cron";
import { startSpecWatcher, type SpecWatcherService } from "./services/spec-watcher";
import { handleCommand } from "./services/command-handler";
import { stopConfigLoader } from "./services/config-loader";
import { lifecycleBus } from "./services/lifecycle-bus";
import { createAppContext, type AppContext } from "./context";
import { TokenStreamLifecycle } from "./credentials/token-stream/lifecycle";

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

const sessionManager = createSessionManager({ db });

// Startup recovery: load active sessions from DB, validate PIDs
sessionManager.init().catch((err) => {
  logger.warn({ error: err instanceof Error ? err.message : String(err) }, "session-manager init failed — starting with empty cache");
});

// ── AppContext — centralized shared state ──────────────────────────────────
const ctx: AppContext = createAppContext({
  db,
  sessionManager,
  lifecycleBus,
  encryptionKey,
  prerotateThreshold,
});

const server = startServer(undefined, db, { encryptionKey, prerotateThreshold }, ctx);

// Register this agent in the DB (non-fatal — agent still serves if this fails)
upsertSelfInRegistry(db).catch((err) => {
  logger.warn({ error: err instanceof Error ? err.message : String(err) }, "agent self-registration failed — will retry on next restart");
});

logger.info({ queryWindowHours: 24 }, "Project discovery query window configured");

// Health snapshot scheduler — persists metrics to PostgreSQL every 30s
const healthScheduler = new HealthScheduler(healthCollector, db);
healthScheduler.start();

// Retention cleanup — prunes old snapshots/events every 24h
const stopRetention = scheduleRetention(db);

// Project registry cleanup — archives stale missing locations every 24h
const stopProjectCleanup = scheduleProjectCleanup(db);

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

// ── Unix socket server ─────────────────────────────────────────────────────
// Accepts NDJSON events from CC hooks and routes them to SessionManager,
// notification router, and command handler.
let socketServer: SocketServer | null = null;

const socketEventHandler = createSocketEventDispatcher({ sessionManager, lifecycleBus });

startSocketServer({
  onEvent: socketEventHandler,
  onCommand: handleCommand,
}).then((srv) => {
  socketServer = srv;
  logger.info({ path: srv.path }, "socket server started");
}).catch((err) => {
  logger.warn(
    { error: err instanceof Error ? err.message : String(err) },
    "socket server unavailable -- socket event ingestion disabled",
  );
});

// ── Token stream lifecycle ─────────────────────────────────────────────────
// Watches per-session transcripts for token usage and persists cost data.
const tokenStreamLifecycle = new TokenStreamLifecycle(db);

lifecycleBus.on("SessionStarted", async (envelope) => {
  const { sessionId, cwd } = envelope.payload;
  try {
    await tokenStreamLifecycle.startWatcher({
      id: sessionId,
      cwd: cwd ?? "",
      ccSessionId: sessionId,
    });
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), sessionId },
      "token stream watcher failed to start",
    );
  }
});

lifecycleBus.on("SessionStopped", async (envelope) => {
  const { sessionId } = envelope.payload;
  try {
    await tokenStreamLifecycle.stopWatcher(sessionId);
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), sessionId },
      "token stream watcher failed to stop",
    );
  }
});

// Resume watchers for sessions that were active before the agent restarted.
tokenStreamLifecycle.resumeActiveWatchers().catch((err) => {
  logger.warn(
    { error: err instanceof Error ? err.message : String(err) },
    "token stream watcher resume failed — will start watchers on new session events",
  );
});

// ── Cron service ───────────────────────────────────────────────────────────
// Scheduled maintenance (daily) and drift detection (weekly).
let cronService: CronService | null = null;
try {
  cronService = startCronService();
  logger.info("cron service started");
} catch (err) {
  logger.warn({ error: err instanceof Error ? err.message : String(err) }, "cron service failed to start");
}

// ── Spec watcher ───────────────────────────────────────────────────────────
// Polls openspec status across registered projects and fires TTS notifications.
let specWatcher: SpecWatcherService | null = null;
try {
  specWatcher = startSpecWatcher();
  logger.info("spec watcher started");
} catch (err) {
  logger.warn({ error: err instanceof Error ? err.message : String(err) }, "spec watcher failed to start");
}

/** Max time to wait for PTY streams to report closure during graceful shutdown. */
const STREAM_SHUTDOWN_TIMEOUT_MS = 5_000;

async function shutdown() {
  logger.info("shutting down nexus-agent");

  // Shut down PTY streams first so child processes receive SIGTERM before the
  // rest of the cleanup tears down the server/DB they might depend on. Bounded
  // by a 5 second grace window — if streams do not report closure in time, we
  // proceed with the remaining cleanup anyway so the process can still exit.
  try {
    const shutdownResult = streamManager.shutdown() as unknown;
    if (shutdownResult instanceof Promise) {
      await Promise.race([
        shutdownResult,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            logger.warn(
              { timeoutMs: STREAM_SHUTDOWN_TIMEOUT_MS },
              "streamManager.shutdown() did not complete within grace window — continuing shutdown",
            );
            resolve();
          }, STREAM_SHUTDOWN_TIMEOUT_MS),
        ),
      ]);
    }
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "streamManager.shutdown() threw — continuing with remaining cleanup",
    );
  }

  // Stop new services first.
  await tokenStreamLifecycle.stopAll();
  specWatcher?.stop();
  cronService?.stop();
  socketServer?.stop();
  stopConfigLoader();
  // Stop existing services.
  healthScheduler.stop();
  stopRetention();
  stopProjectCleanup();
  sessionManager.stop();
  watcherBridge?.shutdown();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
