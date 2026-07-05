import "./otel";
import "./instrument";
import { logger } from "@nexus/core/node";
import { startServer, healthCollector, streamManager } from "./server";
import { createWatcherBridge } from "./watcher-bridge";
import { createSessionManager } from "./session-manager";
import { openDatabase, verifySchema, SchemaIncompleteError } from "./db/database";
import { upsertSelfInRegistry } from "./db/agent-registry";
import { HealthScheduler } from "./health-scheduler";
import { getHealthPushScheduler } from "./health-push/health-push-scheduler";
import { getNotificationPushSubscriber } from "./health-push/notification-push";
import { scheduleRetention } from "./db/retention";
import { scheduleProjectCleanup } from "./db/project-registry";
import { scheduleProjectDiscovery } from "./routes/projects-discovered";
import { loadEncryptionKey, loadPrerotateThreshold } from "./credentials/encryption";
import { startSocketServer, createSocketEventDispatcher, type SocketServer } from "./services/socket-server";
import { startCronService, type CronService } from "./services/cron";
import {
  startCredentialUsagePoller,
  type CredentialUsagePollerService,
} from "./services/credential-usage-poller";
import { getCredentialPool } from "./routes/credentials";
import { evaluateProactiveSwap } from "./services/proactive-swap";
import { lastSwapAt } from "./services/credential-pool/swap-tracker";
import { startSpecWatcher, type SpecWatcherService } from "./services/spec-watcher";
import {
  startTailscalePresencePoller,
  type TailscalePresencePollerService,
} from "./services/tailscale-presence";
import { handleCommand } from "./services/command-handler";
import { getNotificationManager } from "./routes/notifications";
import { initSendTextRoute } from "./routes/commands-send-text";
import { initResizeRoute } from "./routes/commands-resize";
import { stopConfigLoader } from "./services/config-loader";
import { lifecycleBus } from "./services/lifecycle-bus";
import { createAppContext, type AppContext } from "./context";
import { ensureAudioDir } from "./notifications/audio-store";

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

// Schema verification gate — the agent MUST NOT bind :7400 with an empty /
// half-migrated database (see nx-dbame: 7-week silent outage on homelab
// where `db_ok:true` masked `relation "sessions" does not exist`). The probe
// is a single `SELECT to_regclass(...)` per required table — cheap enough to
// run on every startup. Set NEXUS_SKIP_SCHEMA_CHECK=1 to bypass (CI only).
try {
  await verifySchema(db);
} catch (err) {
  if (err instanceof SchemaIncompleteError) {
    logger.fatal(
      {
        missingTables: err.missingTables,
        host: err.host,
        database: err.database,
      },
      err.message,
    );
    process.exit(1);
  }
  // Unexpected failures (network blip, dead pool) — re-throw so the existing
  // unhandled-rejection plumbing surfaces them rather than silently masking.
  throw err;
}

// Bootstrap ~/.config/nexus/audio/ early so the first notification dispatch
// can persist mp3 bytes without a lazy mkdir race. Non-fatal — writeAudio()
// still does mkdir(recursive: true) on every write as a safety net.
ensureAudioDir().catch((err) => {
  logger.warn(
    { error: err instanceof Error ? err.message : String(err) },
    "audio dir bootstrap failed — first notification write will retry",
  );
});

const sessionManager = createSessionManager({ db });

// Wire SessionManager into the POST /commands/send-text route used by the
// watchOS notification action handlers (scaffold-nexus-watch-target task 1.2).
initSendTextRoute(sessionManager);

// Wire SessionManager + StreamManager into the POST /commands/resize route
// used by the take-over PTY viewer (pty-adaptive-geometry-fullscreen task 1.5).
// streamManager is the running server's singleton (see ./server re-export).
initResizeRoute(sessionManager, streamManager);

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

// HealthKit silent-push scheduler — wakes the Nexus iOS app on a guaranteed
// cadence to flush biometric samples to the homelab mx-health ingest (Wave 2).
// Inert when no APNs key / no registered device tokens.
const healthPushScheduler = getHealthPushScheduler();
healthPushScheduler.start();

// Visible iOS alert-push subscriber — fans every `NotificationFired` lifecycle
// event out to all registered iOS tokens as an `aps.alert` push (lock-screen
// banner / Notification Center). Distinct from the SILENT health-flush path
// above (mx-e6h8): before this, notification text only reached SSE listeners
// and never surfaced as a phone banner. Inert when no APNs key / no tokens.
const notificationPushSubscriber = getNotificationPushSubscriber(lifecycleBus);
notificationPushSubscriber.start();

// Retention cleanup — prunes old snapshots/events every 24h
const stopRetention = scheduleRetention(db);

// Project registry cleanup — archives stale missing locations every 24h
const stopProjectCleanup = scheduleProjectCleanup(db);

// Folder-based project auto-discovery — scans the agent's projectsDir for
// repos (.git OR openspec/) at startup and every 60s, upserting into the
// project registry (hidden=true is preserved across re-scans).
const stopProjectDiscovery = scheduleProjectDiscovery(db);

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

const socketEventHandler = createSocketEventDispatcher({
  sessionManager,
  lifecycleBus,
  db,
  // Lazy accessor for the shared NotificationManager singleton (nx-f060f).
  // `initNotificationRoutes` (fire-and-forget inside startServer above) creates
  // it asynchronously, so it may be null right now — the dispatcher resolves it
  // at session_stop dispatch time, by which point startup has long settled.
  getNotificationManager,
});

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

// Token-stream transcript-tail cost reconstruction was RETIRED by
// read-cc-telemetry-from-influxdb — per-session cost/token usage is now read
// from native Claude Code OpenTelemetry series in VictoriaMetrics (see
// apps/agent/src/telemetry/vm-read.ts + the /sessions/{id}/tokens endpoint).
// The token-stream watcher (and the api-error notification sink that rode on
// it) no longer start.

// ── Cron service ───────────────────────────────────────────────────────────
// Scheduled maintenance (daily), drift detection (weekly), and the weekly
// reaper (adopt-reaper-into-nx-cron). The reaper job is gated behind the
// `db` handle — passing `db` here registers the weekly Sun 03:00 sweep
// and starts the stale-heartbeat watchdog.
let cronService: CronService | null = null;
try {
  cronService = startCronService({ db });
  logger.info("cron service started");
} catch (err) {
  logger.warn({ error: err instanceof Error ? err.message : String(err) }, "cron service failed to start");
}

// ── Credential usage poller ────────────────────────────────────────────────
// Periodically samples Anthropic /api/oauth/usage for every primary,
// available credential so the dashboard can show 5h / 7d utilization +
// reset countdowns. Requires the credential pool (initialised by
// `startServer` above through `initCredentialRoutes`).
let credentialUsagePoller: CredentialUsagePollerService | null = null;
try {
  const pool = getCredentialPool();
  if (pool) {
    credentialUsagePoller = startCredentialUsagePoller({
      db,
      pool,
      // Proactive rotation / graduated exhaustion ladder — runs at the end of
      // each successful tick on the freshly-polled 5h usage (credential-proactive-swap).
      onTickComplete: ({ db: tickDb, pool: tickPool }) =>
        evaluateProactiveSwap({
          db: tickDb,
          pool: tickPool,
          swapTracker: { lastSwapAt },
        }),
    });
    logger.info("credential usage poller started");
  } else {
    logger.warn(
      "credential usage poller skipped — credential pool not initialised",
    );
  }
} catch (err) {
  logger.warn(
    { error: err instanceof Error ? err.message : String(err) },
    "credential usage poller failed to start",
  );
}

// ── Spec watcher ───────────────────────────────────────────────────────────
// Polls openspec status across registered projects and fires TTS notifications.
let specWatcher: SpecWatcherService | null = null;
try {
  specWatcher = startSpecWatcher(db);
  logger.info("spec watcher started");
} catch (err) {
  logger.warn({ error: err instanceof Error ? err.message : String(err) }, "spec watcher failed to start");
}

// ── Tailscale presence poller ───────────────────────────────────────────────
// Low-frequency `tailscale status --json` poll that derives the phone's
// home/away/absent state (zero iOS permission) and reports phonePresent /
// phoneHome into the presence vector, feeding Rule 4's room-TTS
// (openspec/changes/mac-presence-observer, Phase 1.5). Resilient: a failed
// `tailscale status` logs a warn and retries next tick, never crashing the
// agent. Match the phone peer via NEXUS_PHONE_PEER (default "iphone").
let tailscalePresencePoller: TailscalePresencePollerService | null = null;
try {
  tailscalePresencePoller = startTailscalePresencePoller();
  logger.info("tailscale presence poller started");
} catch (err) {
  logger.warn(
    { error: err instanceof Error ? err.message : String(err) },
    "tailscale presence poller failed to start",
  );
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
  tailscalePresencePoller?.stop();
  specWatcher?.stop();
  credentialUsagePoller?.stop();
  cronService?.stop();
  socketServer?.stop();
  stopConfigLoader();
  // Stop existing services.
  healthScheduler.stop();
  stopRetention();
  stopProjectCleanup();
  stopProjectDiscovery();
  sessionManager.stop();
  watcherBridge?.shutdown();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
