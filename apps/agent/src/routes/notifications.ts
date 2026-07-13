import { createHash } from "node:crypto";
import type { Db } from "@nexus/db";
import {
  notifications as notificationsTable,
  notificationSettings,
  eq,
} from "@nexus/db";
import { desc } from "drizzle-orm";
import type { NotificationChannel, NotificationPriority } from "@nexus/core";
import { createLogger, getAgentId } from "@nexus/core/node";
import { FLEET_HEARTBEAT_TTL_MS } from "../services/fleet-presence";
import { NotificationManager } from "../notifications/manager";
import { MeetingState } from "../notifications/meeting-state";
import { HeldQueue } from "../notifications/held-queue";
import { safeFireAndForget } from "../utils/safe-fire-and-forget";
import {
  getPresenceContext,
  DEFAULT_PRESENCE_USER,
} from "../notifications/presence-context";
import { audioExists } from "../notifications/audio-store";
import { countRecentNotifications } from "../notifications/buffer";

const log = createLogger("agent:routes:notifications");

/**
 * Channels accepted at the HTTP boundary.
 *
 * `slack` is accepted for backward compatibility — the dispatcher
 * (`notifications/router.ts`) was emptied by `remove-slack-channel`
 * (spine-migration), so any caller still passing `slack` receives a 200
 * with an empty `dispatched` array and a warn-level log entry. Removing
 * `slack` from this set would 400 every legacy caller; the dispatch-side
 * drop is the intended migration path.
 */
const VALID_CHANNELS = new Set<string>(["desktop", "tts", "ropen", "slack", "telegram"]);
const VALID_PRIORITIES = new Set<string>(["low", "normal", "high"]);

// Singleton instances — guarded by a simple async mutex to prevent torn state
// during concurrent reset() / getInstance() calls (D5).
let manager: NotificationManager | null = null;
let meetingState: MeetingState | null = null;
let _singletonLock: Promise<void> = Promise.resolve();

/** Acquire the singleton mutex and run fn exclusively. */
async function withSingletonLock<T>(fn: () => T | Promise<T>): Promise<T> {
  let release!: () => void;
  const prev = _singletonLock;
  _singletonLock = new Promise<void>((res) => { release = res; });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Deduplication (D6)
// ---------------------------------------------------------------------------

/**
 * 2 minutes. Verified against live production data (2026-07-13): the 71
 * observed exact-repeat cases in a 14-day window (same title+body re-fired,
 * typically from a retry-loop emitter) were all spaced 5-23s apart — this
 * window comfortably covers that retry cadence while staying far below any
 * legitimate hours/day-scale recurrence of the same message text.
 */
const DEDUP_TTL_MS = 120_000;
/** Max dedup entries before bulk eviction (memory leak guard). */
const DEDUP_MAX_SIZE = 1_000;
/** Number of oldest entries to evict when capacity is reached. */
const DEDUP_EVICT_BATCH = 100;
/** key → expiry epoch ms */
const dedupMap = new Map<string, number>();

/** Evict expired entries + enforce max-size cap. */
function evictDedupEntries(): void {
  const now = Date.now();
  for (const [k, exp] of dedupMap) {
    if (exp < now) dedupMap.delete(k);
  }
  if (dedupMap.size > DEDUP_MAX_SIZE) {
    let removed = 0;
    for (const key of dedupMap.keys()) {
      if (removed >= DEDUP_EVICT_BATCH) break;
      dedupMap.delete(key);
      removed++;
    }
  }
}

/**
 * Return true if this (message, project, channel) triple was already seen
 * within DEDUP_TTL_MS. `project` is included so the same banner text fired
 * for two distinct projects in the same 5s window is NOT suppressed
 * (analytics-query-and-tts-synthesis). Pass `null`/`undefined` for
 * project-less notifications — the empty-string segment keeps the key
 * shape stable across both cases.
 */
function isDuplicate(
  message: string,
  project: string | null | undefined,
  channel: string,
): boolean {
  const target = `${channel}|${project ?? ""}`;
  const key = createHash("sha256")
    .update(`${message}|${target}`)
    .digest("hex")
    .slice(0, 16);
  evictDedupEntries();
  if (dedupMap.has(key)) return true;
  dedupMap.set(key, Date.now() + DEDUP_TTL_MS);
  return false;
}

/** Reads the live `presence_aware_routing` flag from notification_settings. */
async function readPresenceAwareRouting(db: Db): Promise<boolean> {
  try {
    const row = await db.query.notificationSettings.findFirst({
      where: eq(notificationSettings.id, 1),
    });
    return row?.presenceAwareRouting ?? false;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "presence: failed to read presence_aware_routing flag (defaulting off)",
    );
    return false;
  }
}

/** Reads the live rate-throttle settings from notification_settings. */
async function readRateThrottleSettings(
  db: Db,
): Promise<{ enabled: boolean; maxPerWindow: number; windowMinutes: number }> {
  try {
    const row = await db.query.notificationSettings.findFirst({
      where: eq(notificationSettings.id, 1),
    });
    return {
      enabled: row?.rateThrottleEnabled ?? true,
      maxPerWindow: row?.rateThrottleMaxPerWindow ?? 5,
      windowMinutes: row?.rateThrottleWindowMinutes ?? 5,
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "rate-throttle: failed to read settings (defaulting to enabled, 5/5min)",
    );
    return { enabled: true, maxPerWindow: 5, windowMinutes: 5 };
  }
}

/** Initialize notification routes with a database connection. */
export async function initNotificationRoutes(db: Db): Promise<void> {
  await withSingletonLock(() => {
    meetingState = new MeetingState();

    // Presence-aware routing (context-aware-routing, Phase 1). The presence
    // context binds the meeting-state so meeting transitions feed `inMeeting`;
    // the durable held queue replaces the in-memory meeting buffer.
    const presenceContext = getPresenceContext();
    presenceContext.bindMeetingState(meetingState);
    // Persist this machine's fleet_presence row on every report + heartbeat
    // tick (fleet-aware-rules-eval, Phase 1.7). A remote Mac reporting here now
    // writes ITS OWN per-machine row (nx-vbv39), and the live homelab agent's
    // self-row stays fresh for cross-machine resolution.
    presenceContext.bindFleetPresence(db, getAgentId());
    const heldQueue = new HeldQueue(db, DEFAULT_PRESENCE_USER);

    manager = new NotificationManager(
      db,
      meetingState,
      {
        context: presenceContext,
        heldQueue,
        presenceAwareRouting: () => readPresenceAwareRouting(db),
        // Fleet-aware eval: the manager resolves the live-console machine's
        // stored vector before evaluating the rules, falling back to the local
        // in-memory vector + the all-unknown guard when no live console
        // resolves (no regression for single-machine fleets).
        fleetTtlMs: FLEET_HEARTBEAT_TTL_MS,
      },
      undefined, // crossMachine — not wired at this call site today
      {
        settings: () => readRateThrottleSettings(db),
        countRecent: (project, channel, since) =>
          countRecentNotifications(db, project, channel, since),
      },
    );

    // Rehydrate pending holds on boot: flush anything already due (coalesced
    // summary) and schedule the rest. Survives agent restart — the data-loss
    // bug the in-memory buffer had.
    safeFireAndForget(
      heldQueue.hydrate().then((flushedNow) => {
        if (flushedNow.length > 0 && manager) {
          safeFireAndForget(
            manager.flushHeldBatch(flushedNow),
            "held-queue-flush-batch",
          );
        }
      }),
      "held-queue-hydrate",
    );
  });
}

/** Get the manager (for testing). */
export function getNotificationManager(): NotificationManager | null {
  return manager;
}

/** Reset state — mutex-guarded to prevent torn state (D5). */
export async function resetNotificationRoutes(): Promise<void> {
  await withSingletonLock(() => {
    manager = null;
    meetingState = null;
  });
  dedupMap.clear();
}

/** Expose dedup internals for testing. */
export const _testDedupInternals = {
  get map() { return dedupMap; },
  isDuplicate,
  DEDUP_TTL_MS,
  DEDUP_MAX_SIZE,
};

/** POST /notifications/send — queue a notification. */
export async function handleSendNotification(
  db: Db,
  request: Request,
): Promise<Response> {
  if (!manager) {
    return jsonResponse({ error: "notification system not initialized" }, 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const { id, channel, title, body: notifBody, project, priority, url } = body as Record<
    string,
    unknown
  >;

  if (!id || typeof id !== "string") {
    return jsonResponse({ error: "id is required and must be a string" }, 400);
  }
  if (!channel || !VALID_CHANNELS.has(channel as string)) {
    return jsonResponse(
      { error: `channel must be one of: ${[...VALID_CHANNELS].join(", ")}` },
      400,
    );
  }
  if (!title || typeof title !== "string") {
    return jsonResponse({ error: "title is required and must be a string" }, 400);
  }
  if (!notifBody || typeof notifBody !== "string") {
    return jsonResponse({ error: "body is required and must be a string" }, 400);
  }
  // Message body validation: non-empty and max 500 chars (D8).
  if ((notifBody as string).length === 0) {
    return jsonResponse({ error: "validation", detail: "message body is empty" }, 400);
  }
  if ((notifBody as string).length > 500) {
    return jsonResponse({ error: "validation", detail: "message body exceeds 500 characters" }, 400);
  }
  if (priority && !VALID_PRIORITIES.has(priority as string)) {
    return jsonResponse(
      { error: `priority must be one of: ${[...VALID_PRIORITIES].join(", ")}` },
      400,
    );
  }

  // Deduplication: suppress identical (body, project, channel) triples within
  // 5 seconds (D6 + analytics-query-and-tts-synthesis fix). Same body for two
  // different projects in the same window is allowed (both delivered).
  if (
    isDuplicate(
      notifBody as string,
      (project as string | null | undefined) ?? null,
      channel as string,
    )
  ) {
    log.info({ id, channel, project }, "notification suppressed (duplicate within 5s)");
    return jsonResponse({ suppressed: true }, 200);
  }

  const notification = await manager.send({
    id: id as string,
    channel: channel as string,
    title: title as string,
    body: notifBody as string,
    project: (project as string) ?? null,
    // Route has no agent context; pass null (global notification).
    agentId: null,
    priority: (priority as NotificationPriority) ?? "normal",
    createdAt: new Date(),
  }, url ? { url: url as string } : undefined);

  return jsonResponse(notification, 201);
}

/** POST /meeting/start — begin meeting mode. */
export function handleMeetingStart(): Response {
  if (!manager) {
    return jsonResponse({ error: "notification system not initialized" }, 500);
  }

  manager.startMeeting();
  // Feed the presence vector's inMeeting field from the meeting-state machine.
  getPresenceContext().syncMeetingState();
  return jsonResponse({ status: "meeting started", ...manager.getMeetingState().status() });
}

/** POST /meeting/end — end meeting, flush buffered notifications. */
export async function handleMeetingEnd(): Promise<Response> {
  if (!manager) {
    return jsonResponse({ error: "notification system not initialized" }, 500);
  }

  const flushed = await manager.endMeeting();
  // Sync the presence vector now the meeting is over (inMeeting -> false).
  getPresenceContext().syncMeetingState();
  return jsonResponse({ status: "meeting ended", flushed });
}

/** GET /meeting/status — current meeting state. */
export function handleMeetingStatus(): Response {
  if (!manager) {
    return jsonResponse({ error: "notification system not initialized" }, 500);
  }

  return jsonResponse(manager.getMeetingState().status());
}

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /notifications — return the canonical NotificationEvent list.
 *
 * Added by `agent-payload-completeness` — the Swift dashboard's
 * NotificationEvent decoder previously had nothing to fetch. Each row
 * includes the Swift-facing `severity` (info|warn|error) and
 * `delivery_state` (pending|delivered|failed) enums.
 *
 * Returns `[]` on empty (never 404). Returns 500 with `{ error }` on a
 * DB failure so the caller knows the table is unreachable (distinct from
 * the empty-set case).
 */
export async function handleListNotifications(db: Db): Promise<Response> {
  try {
    const rows = await db
      .select({
        id: notificationsTable.id,
        title: notificationsTable.title,
        body: notificationsTable.body,
        channel: notificationsTable.channel,
        project: notificationsTable.project,
        severity: notificationsTable.severity,
        delivery_state: notificationsTable.deliveryState,
        created_at: notificationsTable.createdAt,
        // notifications-overhaul (task 2.10) — surface the audio
        // bookkeeping columns. `voice_used` is column-passthrough;
        // `audioAvailable` is a per-row stat() check (the DB column
        // and the filesystem can drift if the cron sweep pruned the
        // mp3 between writes).
        voice_used: notificationsTable.voiceUsed,
        audio_path: notificationsTable.audioPath,
      })
      .from(notificationsTable)
      .orderBy(desc(notificationsTable.createdAt))
      .limit(200);

    // Project Date columns to ISO strings on the wire — the Swift decoder
    // expects an ISO-8601 string for created_at (matches /sessions shape).
    const payload = rows.map((r) => {
      // Stat-based liveness — when the file was pruned the column may
      // still be set; we honor the filesystem, not the column.
      const hasFile = r.audio_path != null && audioExists(r.id);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { audio_path: _drop, ...rest } = r;
      return {
        ...rest,
        created_at:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : (r.created_at as unknown as string),
        audioAvailable: hasFile,
        voiceUsed: r.voice_used ?? null,
      };
    });

    return jsonResponse(payload, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "GET /notifications failed",
    );
    return jsonResponse({ error: "failed to list notifications" }, 500);
  }
}
