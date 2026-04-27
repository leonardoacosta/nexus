"use server";

/**
 * Server actions backing the `/notifications` dashboard page.
 *
 * Two reads, two writes:
 *   - `fetchNotificationSettings()`  — GET /notifications/settings on the agent
 *   - `fetchRecentNotifications(limit)` — direct DB read of the last N rows
 *     (no GET /notifications endpoint exists on the agent today; the
 *     dashboard already has a read-only DB handle for similar pages)
 *   - `updateNotificationSettings(patch)` — PATCH /notifications/settings
 *   - `replayNotification(input)` — POST /notifications/send with a fresh id
 */

import { fetchWithTimeout } from "@nexus/core/fetch";
import { notifications, desc } from "@nexus/db";
import type { Notification } from "@nexus/db";
import { getAgentBaseUrl } from "@/lib/agent-url";
import { getReadOnlyDb } from "@/lib/db";

const REQUEST_TIMEOUT_MS = 5_000;

// ── Types ────────────────────────────────────────────────────────────────────

export type DuckingMode = "full" | "half" | "mute";

/** Wire shape returned by GET / PATCH /notifications/settings. */
export interface NotificationSettingsWire {
  id: number;
  tts_enabled: boolean;
  banner_enabled: boolean;
  ducking_mode: DuckingMode;
  updated_at: string;
}

export interface NotificationSettingsPatch {
  tts_enabled?: boolean;
  banner_enabled?: boolean;
  ducking_mode?: DuckingMode;
}

/**
 * Notification row reshaped for the dashboard. ISO timestamp strings (vs
 * `Date`) so the value crosses the RSC → client boundary cleanly.
 */
export interface NotificationRow {
  id: string;
  channel: string;
  title: string;
  body: string;
  project: string | null;
  agentId: string | null;
  priority: string;
  status: string;
  createdAt: string;
  sentAt: string | null;
}

export interface NotificationsPageData {
  settings: NotificationSettingsWire | null;
  rows: NotificationRow[];
  agentReachable: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  return {
    "x-nexus-secret": process.env.NEXUS_ATTACH_SECRET ?? "",
  };
}

function rowToWire(row: Notification): NotificationRow {
  return {
    id: row.id,
    channel: row.channel,
    title: row.title,
    body: row.body,
    project: row.project,
    agentId: row.agentId,
    priority: row.priority,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * GET /notifications/settings.
 *
 * Returns null when the agent is unreachable or the row is missing — the
 * client renders defaults in that case (the Mac listener already has a
 * hardcoded fallback so this isn't a hard failure).
 */
export async function fetchNotificationSettings(): Promise<NotificationSettingsWire | null> {
  const resolved = await getAgentBaseUrl();
  if (!resolved) return null;
  try {
    const res = await fetchWithTimeout(
      `${resolved.baseUrl}/notifications/settings`,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: authHeaders(),
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as NotificationSettingsWire;
  } catch {
    return null;
  }
}

/**
 * Fetch the last `limit` notification rows from the DB (read-only handle).
 *
 * Sorted by `createdAt` descending. The agent does not currently expose a
 * `GET /notifications` list endpoint, so we read the same Postgres table the
 * agent writes to. `apps/nextjs/src/lib/db.ts` enforces read-only access at
 * the type level — no mutation can compile here.
 */
export async function fetchRecentNotifications(
  limit = 50,
): Promise<NotificationRow[]> {
  const db = getReadOnlyDb();
  const rows = await db
    .select()
    .from(notifications)
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  return rows.map(rowToWire);
}

/**
 * Bundle the two reads the page needs into one server-side hop. Errors are
 * isolated per-source so a missing settings row doesn't blank the table.
 */
export async function fetchNotificationsPageData(): Promise<NotificationsPageData> {
  const [settings, rows] = await Promise.all([
    fetchNotificationSettings(),
    fetchRecentNotifications(50).catch(() => [] as NotificationRow[]),
  ]);
  return {
    settings,
    rows,
    agentReachable: settings !== null,
  };
}

/**
 * PATCH /notifications/settings.
 *
 * Throws on non-2xx so the client can revert the optimistic update and show
 * a toast. Returns the post-update wire shape on success.
 */
export async function updateNotificationSettings(
  patch: NotificationSettingsPatch,
): Promise<NotificationSettingsWire> {
  const resolved = await getAgentBaseUrl();
  if (!resolved) {
    throw new Error("agent unreachable");
  }
  const res = await fetchWithTimeout(
    `${resolved.baseUrl}/notifications/settings`,
    {
      method: "PATCH",
      timeout: REQUEST_TIMEOUT_MS,
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      cache: "no-store",
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `PATCH /notifications/settings → ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return (await res.json()) as NotificationSettingsWire;
}

export interface ReplayInput {
  channel: string;
  title: string;
  body: string;
  project: string | null;
  priority?: string;
}

/**
 * POST /notifications/send with a freshly-generated id. Used by the row-level
 * replay button (▶) — the agent treats this as a brand-new notification (it
 * persists, fires the listeners, re-runs dedup against the 5s window).
 */
export async function replayNotification(
  input: ReplayInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const resolved = await getAgentBaseUrl();
  if (!resolved) return { ok: false, error: "agent unreachable" };

  const id = `replay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const res = await fetchWithTimeout(`${resolved.baseUrl}/notifications/send`, {
      method: "POST",
      timeout: REQUEST_TIMEOUT_MS,
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        channel: input.channel,
        title: input.title,
        body: input.body,
        project: input.project,
        priority: input.priority ?? "normal",
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `POST /notifications/send → ${res.status}${text ? `: ${text}` : ""}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
