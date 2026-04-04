import type { Database } from "bun:sqlite";
import type { NotificationChannel, NotificationPriority } from "@nexus/core";
import { NotificationManager } from "../notifications/manager";
import { MeetingState } from "../notifications/meeting-state";

const VALID_CHANNELS = new Set<string>(["desktop", "tts", "slack"]);
const VALID_PRIORITIES = new Set<string>(["low", "normal", "high"]);

// Singleton instances — initialized once via initNotificationRoutes()
let manager: NotificationManager | null = null;
let meetingState: MeetingState | null = null;

/** Initialize notification routes with a database connection. */
export function initNotificationRoutes(db: Database): void {
  meetingState = new MeetingState();
  manager = new NotificationManager(db, meetingState);
}

/** Get the manager (for testing). */
export function getNotificationManager(): NotificationManager | null {
  return manager;
}

/** Reset state (for testing). */
export function resetNotificationRoutes(): void {
  manager = null;
  meetingState = null;
}

/** POST /notifications/send — queue a notification. */
export async function handleSendNotification(
  db: Database,
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
  if (priority && !VALID_PRIORITIES.has(priority as string)) {
    return jsonResponse(
      { error: `priority must be one of: ${[...VALID_PRIORITIES].join(", ")}` },
      400,
    );
  }

  const notification = await manager.send({
    id: id as string,
    channel: channel as string,
    title: title as string,
    body: notifBody as string,
    project: (project as string) ?? null,
    priority: (priority as NotificationPriority) ?? "normal",
    created_at: new Date().toISOString(),
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
