import { createHash } from "node:crypto";
import type { Db } from "@nexus/db";
import type { NotificationChannel, NotificationPriority } from "@nexus/core";
import { createLogger } from "@nexus/core";
import { NotificationManager } from "../notifications/manager";
import { MeetingState } from "../notifications/meeting-state";

const log = createLogger("agent:routes:notifications");

const VALID_CHANNELS = new Set<string>(["desktop", "tts", "slack"]);
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

const DEDUP_TTL_MS = 5_000;
/** key → expiry epoch ms */
const dedupMap = new Map<string, number>();

/** Return true if this (message, target) pair was already seen within DEDUP_TTL_MS. */
function isDuplicate(message: string, target: string): boolean {
  const key = createHash("sha256")
    .update(`${message}|${target}`)
    .digest("hex")
    .slice(0, 16);
  const now = Date.now();
  // Evict expired entries on each lookup.
  for (const [k, exp] of dedupMap) {
    if (exp < now) dedupMap.delete(k);
  }
  if (dedupMap.has(key)) return true;
  dedupMap.set(key, now + DEDUP_TTL_MS);
  return false;
}

/** Initialize notification routes with a database connection. */
export async function initNotificationRoutes(db: Db): Promise<void> {
  await withSingletonLock(() => {
    meetingState = new MeetingState();
    manager = new NotificationManager(db, meetingState);
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
}

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

  const { id, channel, title, body: notifBody, project, priority } = body as Record<
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

  // Deduplication: suppress identical (body, channel) pairs within 5 seconds (D6).
  const target = `${channel as string}`;
  if (isDuplicate(notifBody as string, target)) {
    log.info({ id, channel }, "notification suppressed (duplicate within 5s)");
    return jsonResponse({ suppressed: true }, 200);
  }

  const notification = await manager.send({
    id: id as string,
    channel: channel as string,
    title: title as string,
    body: notifBody as string,
    project: (project as string) ?? null,
    priority: (priority as NotificationPriority) ?? "normal",
    createdAt: new Date(),
  });

  return jsonResponse(notification, 201);
}

/** POST /meeting/start — begin meeting mode. */
export function handleMeetingStart(): Response {
  if (!manager) {
    return jsonResponse({ error: "notification system not initialized" }, 500);
  }

  manager.startMeeting();
  return jsonResponse({ status: "meeting started", ...manager.getMeetingState().status() });
}

/** POST /meeting/end — end meeting, flush buffered notifications. */
export async function handleMeetingEnd(): Promise<Response> {
  if (!manager) {
    return jsonResponse({ error: "notification system not initialized" }, 500);
  }

  const flushed = await manager.endMeeting();
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
