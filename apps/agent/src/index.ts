// MUST be first — disables Bun's node:net Happy Eyeballs (autoSelectFamily)
// racing before any outbound connection (OTLP exporter, postgres-js) opens.
// Removes the internalConnectMultipleTimeout null-context crash (nx-veo5g.5).
import "./net-autoselect-family";
import "./otel";
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
import {
  startCredentialRefreshJob,
  type CredentialRefreshJobService,
} from "./services/credential-refresh-job";
import { getCredentialPool } from "./routes/credentials";
import { evaluateProactiveSwap } from "./services/proactive-swap";
import { writeStatuslineUsageFile } from "./services/statusline-usage-file";
import { lastSwapAt } from "./services/credential-pool/swap-tracker";
import { startSpecWatcher, type SpecWatcherService } from "./services/spec-watcher";
import { startBeadsWatcher, type BeadsWatcherHandle } from "./services/beads-watcher";
import { startGitObserver, type GitObserverHandle } from "./services/git-observer";
import {
  startTailscalePresencePoller,
  type TailscalePresencePollerService,
} from "./services/tailscale-presence";
import { handleCommand } from "./services/command-handler";
import { getNotificationManager } from "./routes/notifications";
import { initSendTextRoute } from "./routes/commands-send-text";
import { initResizeRoute } from "./routes/commands-resize";
import { stopConfigLoader, getProjects } from "./services/config-loader";
import { lifecycleBus } from "./services/lifecycle-bus";
import { createAppContext, type AppContext } from "./context";
import { ensureAudioDir } from "./notifications/audio-store";
import { startMemoryPressureMonitor } from "./services/memory-pressure";
import { startSdNotifyWatchdog } from "./services/sd-notify";
import { restoreSnapshot, startStateSnapshot } from "./services/state-snapshot";
// Side-effect imports: force the behavioral-state sources to register their
// serialize/deserialize pairs before restoreSnapshot() runs (nx-veo5g.4). The
// other three sources (notifications, proactive-swap, swap-tracker) are already
// imported above for their exported symbols.
import "./services/schema-drift";
import "./services/credential-pool/rate-limit-tracker";

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

// Restore behavioral in-memory state from the last snapshot BEFORE any service
// starts mutating it (nx-veo5g.4, Layer D). Non-fatal on a missing/corrupt
// snapshot — matches the sessionManager.init() convention below. All five source
// modules have registered by now (top-level imports run first).
try {
  restoreSnapshot();
} catch (err) {
  logger.warn(
    { error: err instanceof Error ? err.message : String(err) },
    "behavioral state restore failed — starting with empty in-memory state",
  );
}

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

// Diagnostic memory-pressure sampler (nx-t9wlb): logs a structured WARN when
// the agent's cgroup memory usage approaches its systemd MemoryMax cap, so a
// future SIGABRT/SIGILL-under-load crash leaves an investigable trail. No-op on
// non-Linux / unbounded-cgroup hosts.
const stopMemoryPressureMonitor = startMemoryPressureMonitor();

// systemd hardware watchdog keep-alive (nexus-self-healing-infra): feeds
// `WATCHDOG=1` to `$NOTIFY_SOCKET` at less than half of `nexus-agent.service`'s
// `WatchdogSec=30`, so systemd force-kills + restarts a hung-but-alive event
// loop (the case `Restart=always` alone never catches). Silent no-op when
// `$NOTIFY_SOCKET` is unset (local dev, macOS).
const stopSdNotifyWatchdog = startSdNotifyWatchdog();

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

// ── Credential refresh job ─────────────────────────────────────────────────
// Proactively refreshes OAuth access tokens for pooled credentials whose
// expiry is within 15 minutes, EXCLUDING the currently-active credential
// (Claude Code itself keeps that one fresh via active-credential-watcher.ts's
// unconditional mirror). Fixes the root cause of the usage poller below
// failing on every poll: nothing was ever refreshing a pooled credential's
// access token once it wasn't the active CC session anymore. Requires the
// credential pool (same precondition as the usage poller below).
let credentialRefreshJob: CredentialRefreshJobService | null = null;
try {
  const pool = getCredentialPool();
  if (pool) {
    credentialRefreshJob = startCredentialRefreshJob({ db, pool });
    logger.info("credential refresh job started");
  } else {
    logger.warn(
      "credential refresh job skipped — credential pool not initialised",
    );
  }
} catch (err) {
  logger.warn(
    { error: err instanceof Error ? err.message : String(err) },
    "credential refresh job failed to start",
  );
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
      // Runs at the end of each successful tick on the freshly-polled 5h usage:
      //   1. Proactive rotation / graduated exhaustion ladder (credential-proactive-swap).
      //   2. Mirror the active credential's polled usage to usage-cache.json so
      //      nexus-statusline / cc-tmux read it instead of calling Anthropic
      //      (cc-tmux-session-usage-bars, usage consolidation). Fail-soft.
      onTickComplete: async ({ db: tickDb, pool: tickPool }) => {
        await evaluateProactiveSwap({
          db: tickDb,
          pool: tickPool,
          swapTracker: { lastSwapAt },
        });
        await writeStatuslineUsageFile(tickDb);
      },
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

// ── Beads watcher ────────────────────────────────────────────────────────────
// Watches each registered project's .beads/issues.jsonl (bd's export.auto
// signal) and recomputes unlinked ready/blocked counts into
// project_status_snapshots — zero bd CLI shell-outs on the hot path
// (add-project-status-snapshots). Default sink is recordProjectStatusFromBeads
// since `db` is supplied; projects come from the config-loader registry.
let beadsWatcher: BeadsWatcherHandle | null = null;
try {
  beadsWatcher = startBeadsWatcher({ db, listProjects: getProjects });
  logger.info("beads watcher started");
} catch (err) {
  logger.warn({ error: err instanceof Error ? err.message : String(err) }, "beads watcher failed to start");
}

// ── Git observer ──────────────────────────────────────────────────────────────
// 60s staggered poll over registered local project locations, persisting
// branch-switch / new-commit / detached-head transitions into git_events and
// folding current git state into the /projects/:id/status payload — zero fs
// watches (dirty state is working-tree-wide) (add-git-status-orbit). Projects
// come from the config-loader registry; fail-open per project.
let gitObserver: GitObserverHandle | null = null;
try {
  gitObserver = startGitObserver({
    db,
    listProjects: () =>
      getProjects().map((p) => ({ code: p.code, path: p.path })),
  });
  logger.info("git observer started");
} catch (err) {
  logger.warn({ error: err instanceof Error ? err.message : String(err) }, "git observer failed to start");
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

// Behavioral-state periodic snapshot (nx-veo5g.4, Layer D). Debounced, content-
// diff'd disk flush of the registered in-memory sources. `stopStateSnapshot()`
// does a final forced flush on graceful shutdown so the freshest state lands.
const stopStateSnapshot = startStateSnapshot();

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
  gitObserver?.stop();
  beadsWatcher?.stop();
  specWatcher?.stop();
  credentialUsagePoller?.stop();
  credentialRefreshJob?.stop();
  cronService?.stop();
  socketServer?.stop();
  stopConfigLoader();
  // Stop existing services.
  healthScheduler.stop();
  stopMemoryPressureMonitor();
  stopSdNotifyWatchdog();
  stopRetention();
  stopProjectCleanup();
  stopProjectDiscovery();
  sessionManager.stop();
  watcherBridge?.shutdown();
  // Final forced flush of behavioral in-memory state before the process exits.
  stopStateSnapshot();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Process-level failure observability (nx-veo5g.3). Before this, an
// unhandledRejection or a JS-level uncaughtException left ZERO diagnostic
// trail — the agent either kept running in an unknown state or was killed by
// the runtime default with nothing structured logged. These handlers do NOT
// address the native SIGABRT (a Go/Bun abort() is uncatchable from JS — that
// is the memory-exhaustion root cause the spawn budget above targets); they
// close the separate observability gap for catchable JS failures.
process.on("unhandledRejection", (reason, promise) => {
  // Log and continue — matches the Bun runtime's non-fatal default for
  // unhandled rejections, so this is purely additive diagnostics (no new
  // process-lifecycle behavior).
  logger.error(
    {
      reason:
        reason instanceof Error
          ? { message: reason.message, stack: reason.stack, name: reason.name }
          : reason,
      at: "unhandledRejection",
    },
    "Unhandled promise rejection — investigate (agent continues running)",
  );
  void promise;
});

process.on("uncaughtException", (err) => {
  // An uncaught exception leaves the process in an undefined state; log with
  // full context, then exit so systemd restarts a clean instance. Registering
  // a handler suppresses the runtime's own auto-exit, so the explicit
  // process.exit(1) is load-bearing to preserve the prior crash-and-restart
  // lifecycle (now with a diagnostic trail).
  logger.fatal(
    { err, at: "uncaughtException" },
    "Uncaught exception — exiting for a clean restart",
  );
  process.exit(1);
});
