/**
 * Analytics routes — health time-series, spec velocity, credentials,
 * git activity, lifecycle events, cron history.
 *
 * Mirrors the Rust agent's analytics handlers. The health endpoint is
 * superseded by the PostgreSQL-backed /health/history route, so this
 * returns an empty array for parity. Other endpoints stub their
 * response shapes to match the Rust agent contract while delegating
 * to the Bun agent's PostgreSQL-backed stores where available.
 */

import type { Db } from "@nexus/db";
import { notifications as notificationsTable } from "@nexus/db";
import { and, desc, eq, gte, or, lt, type SQL } from "drizzle-orm";
import { queryHealthTimeSeries } from "../db/health";
import { audioExists } from "../notifications/audio-store";
import { createLogger } from "@nexus/core/node";
import type {
  AnalyticsNotificationRow,
  AnalyticsNotificationsResponse,
  NotificationChannel,
  NotificationDeliveryState,
  NotificationPriority,
  NotificationSeverity,
  NotificationStatus,
} from "@nexus/core";

const log = createLogger("agent:routes:analytics");

// ---------------------------------------------------------------------------
// GET /analytics/health
// ---------------------------------------------------------------------------

/**
 * GET /analytics/health?hours=N
 *
 * Superseded by /health/history (PostgreSQL-backed). Returns data from
 * the same health_snapshots table for backward compatibility.
 */
export async function handleAnalyticsHealth(
  db: Db,
  url: URL,
): Promise<Response> {
  const hoursParam = url.searchParams.get("hours");
  const hours = hoursParam ? Number(hoursParam) : 24;

  if (Number.isNaN(hours) || hours <= 0) {
    return new Response(
      JSON.stringify({ error: "hours must be a positive number" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const rows = await queryHealthTimeSeries(db, hours);
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    log.error({ err }, "analytics/health query failed");
    return new Response(
      JSON.stringify({ error: "internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

// ---------------------------------------------------------------------------
// GET /analytics/notifications
// ---------------------------------------------------------------------------

/** Default page size when `?limit=` is absent. */
const DEFAULT_LIMIT = 50;
/** Hard maximum page size; requests above this return HTTP 400. */
const MAX_LIMIT = 500;

/**
 * Decoded keyset cursor — the `(created_at, id)` tuple of the LAST row of
 * the previous page. The next page returns rows strictly older than this.
 */
export interface AnalyticsCursor {
  created_at: Date;
  id: string;
}

/**
 * Parse an opaque base64url cursor token into `{created_at, id}`.
 *
 * Returns a discriminated result so the caller can render a precise 400
 * error matching the spec scenarios (malformed base64, missing field,
 * non-ISO timestamp, future timestamp).
 */
export type CursorParseResult =
  | { ok: true; value: AnalyticsCursor }
  | { ok: false; reason: string };

export function parseCursor(token: string): CursorParseResult {
  if (!token) return { ok: false, reason: "cursor: malformed base64" };

  let decoded: string;
  try {
    // Node's Buffer accepts both "base64" and "base64url"; the latter is what
    // we emit. Strict round-trip check rejects garbage that Buffer would
    // silently swallow.
    decoded = Buffer.from(token, "base64url").toString("utf8");
    const reencoded = Buffer.from(decoded, "utf8").toString("base64url");
    if (reencoded !== token) {
      return { ok: false, reason: "cursor: malformed base64" };
    }
  } catch {
    return { ok: false, reason: "cursor: malformed base64" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, reason: "cursor: malformed base64" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "cursor: missing field 'created_at'" };
  }

  const obj = parsed as Record<string, unknown>;
  if (!("created_at" in obj)) {
    return { ok: false, reason: "cursor: missing field 'created_at'" };
  }
  if (!("id" in obj)) {
    return { ok: false, reason: "cursor: missing field 'id'" };
  }
  if (typeof obj.created_at !== "string") {
    return { ok: false, reason: "cursor: created_at must be ISO-8601 string" };
  }
  if (typeof obj.id !== "string") {
    return { ok: false, reason: "cursor: id must be string" };
  }

  const ts = new Date(obj.created_at);
  if (Number.isNaN(ts.getTime())) {
    return { ok: false, reason: "cursor: created_at must be ISO-8601 string" };
  }
  if (ts.getTime() > Date.now()) {
    return { ok: false, reason: "cursor: created_at must not be in the future" };
  }

  return { ok: true, value: { created_at: ts, id: obj.id } };
}

/**
 * Encode the `(created_at, id)` keyset of a row into an opaque base64url
 * cursor token. Symmetric inverse of `parseCursor` — `parseCursor(encodeCursor(x))`
 * always returns `{ ok: true, value: x }` for any valid input.
 */
export function encodeCursor(row: { created_at: Date; id: string }): string {
  const payload = JSON.stringify({
    created_at: row.created_at.toISOString(),
    id: row.id,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * GET /analytics/notifications?hours=N&project=X&status=Y&limit=L&cursor=C
 *
 * Query the `notifications` table with optional filters and keyset
 * pagination. Defaults to the trailing 24 hours, page size 50, no
 * project/status filter, and no cursor (first page).
 *
 * Query parameters:
 * - `hours` (default 24): time-window in hours; rejected if <= 0
 * - `project` (optional): filter by project identifier
 * - `status` (optional): filter by delivery status
 * - `limit` (default 50, max 500): page size; rejected if <= 0 or > 500
 * - `cursor` (optional): opaque base64url token from a prior response's
 *   `next_cursor`. Validated strictly: malformed input returns HTTP 400
 *   with `{error: "cursor: <reason>"}`. See `parseCursor` for the failure
 *   taxonomy.
 *
 * Response envelope (`AnalyticsNotificationsResponse`):
 * ```
 * {
 *   rows: [...],            // up to `limit` rows, sorted (created_at DESC, id DESC)
 *   next_cursor: string|null,  // opaque token for the next page
 *   has_more: boolean,         // true iff next_cursor != null
 *   count: number,             // rows.length
 *   filters: { hours, project, status }
 * }
 * ```
 *
 * Pagination is single-axis `(created_at DESC, id DESC)` keyset — no
 * `?sort=` or `?offset=` are accepted. The handler fetches `limit + 1`
 * rows to detect `has_more` without a separate COUNT query.
 *
 * Spec: analytics-query-and-tts-synthesis, analytics-pagination-cursor.
 * Returns HTTP 200 with empty `rows: []` when nothing matches — never 404
 * (path matched; empty-set has its own contract).
 */
export async function handleAnalyticsNotifications(
  db: Db,
  url: URL,
): Promise<Response> {
  const hoursParam = url.searchParams.get("hours");
  const projectParam = url.searchParams.get("project");
  const statusParam = url.searchParams.get("status");
  const limitParam = url.searchParams.get("limit");
  const cursorParam = url.searchParams.get("cursor");

  const hours = hoursParam ? Number(hoursParam) : 24;
  if (Number.isNaN(hours) || hours <= 0) {
    return new Response(
      JSON.stringify({ error: "hours must be a positive number" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Limit validation: explicit reject (NOT clamp) per spec — the dashboard
  // depends on this to surface client-side bugs early instead of silently
  // truncating expected page sizes.
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
      return new Response(
        JSON.stringify({ error: "limit must be between 1 and 500" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    limit = Math.floor(parsed);
  }

  let cursor: AnalyticsCursor | null = null;
  if (cursorParam !== null && cursorParam !== "") {
    const result = parseCursor(cursorParam);
    if (!result.ok) {
      return new Response(
        JSON.stringify({ error: result.reason }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    cursor = result.value;
  }

  const cutoff = new Date(Date.now() - hours * 3600_000);
  const conditions: SQL[] = [gte(notificationsTable.createdAt, cutoff)];
  if (projectParam) conditions.push(eq(notificationsTable.project, projectParam));
  if (statusParam) conditions.push(eq(notificationsTable.status, statusParam));

  // Keyset WHERE: rows strictly older than the cursor tuple under the
  // (created_at DESC, id DESC) sort. Using row-value comparison via
  // `(created_at, id) < (c, id)` keeps the index usage clean on
  // (created_at DESC) without a synthetic compound column.
  if (cursor) {
    const keysetClause = or(
      lt(notificationsTable.createdAt, cursor.created_at),
      and(
        eq(notificationsTable.createdAt, cursor.created_at),
        lt(notificationsTable.id, cursor.id),
      ),
    );
    if (keysetClause) conditions.push(keysetClause);
  }

  try {
    // Fetch limit + 1 to detect has_more without a separate COUNT.
    const rawRows = await db
      .select({
        id: notificationsTable.id,
        channel: notificationsTable.channel,
        title: notificationsTable.title,
        body: notificationsTable.body,
        project: notificationsTable.project,
        priority: notificationsTable.priority,
        status: notificationsTable.status,
        severity: notificationsTable.severity,
        deliveryState: notificationsTable.deliveryState,
        createdAt: notificationsTable.createdAt,
        sentAt: notificationsTable.sentAt,
        audioPath: notificationsTable.audioPath,
        voiceUsed: notificationsTable.voiceUsed,
      })
      .from(notificationsTable)
      .where(and(...conditions))
      .orderBy(desc(notificationsTable.createdAt), desc(notificationsTable.id))
      .limit(limit + 1);

    const hasMore = rawRows.length > limit;
    const kept = hasMore ? rawRows.slice(0, limit) : rawRows;

    const rows: AnalyticsNotificationRow[] = kept.map((r) => {
      const createdAt =
        r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string);
      const audio_available =
        r.audioPath != null && r.audioPath !== "" && audioExists(r.id);
      return {
        id: r.id,
        channel: r.channel as NotificationChannel,
        title: r.title,
        body: r.body,
        project: r.project,
        priority: r.priority as NotificationPriority,
        status: r.status as NotificationStatus,
        severity: r.severity as NotificationSeverity,
        delivery_state: r.deliveryState as NotificationDeliveryState,
        created_at: createdAt.toISOString(),
        sent_at:
          r.sentAt instanceof Date
            ? r.sentAt.toISOString()
            : (r.sentAt as unknown as string | null) ?? null,
        voice_used: r.voiceUsed ?? null,
        audio_available,
      };
    });

    const nextCursor =
      hasMore && rows.length > 0
        ? encodeCursor({
            created_at: new Date(rows[rows.length - 1]!.created_at),
            id: rows[rows.length - 1]!.id,
          })
        : null;

    const response: AnalyticsNotificationsResponse = {
      rows,
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
      count: rows.length,
      filters: {
        hours,
        project: projectParam,
        status: statusParam,
      },
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "analytics/notifications query failed",
    );
    return new Response(
      JSON.stringify({ error: "internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

// ---------------------------------------------------------------------------
// GET /analytics/specs
// ---------------------------------------------------------------------------

/**
 * GET /analytics/specs?project=X&days=N
 *
 * Spec delivery velocity data. Currently returns empty snapshots array
 * since the spec snapshot table lives in the Rust agent's SQLite.
 */
export async function handleAnalyticsSpecs(
  _db: Db,
  url: URL,
): Promise<Response> {
  const _project = url.searchParams.get("project");
  const _days = url.searchParams.get("days");

  // Spec snapshots are tracked in the Rust agent's SQLite DB.
  // Return empty for now -- the TUI should query the Rust agent directly.
  return new Response(
    JSON.stringify({ snapshots: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// GET /analytics/credentials
// ---------------------------------------------------------------------------

/**
 * GET /analytics/credentials?hours=N
 *
 * Credential pool usage analytics. Returns empty arrays since credential
 * poll/swap tracking is in the Rust agent's SQLite.
 */
export async function handleAnalyticsCredentials(
  _db: Db,
  url: URL,
): Promise<Response> {
  const _hours = url.searchParams.get("hours");

  return new Response(
    JSON.stringify({ polls: [], swaps: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// GET /analytics/git
// ---------------------------------------------------------------------------

/**
 * GET /analytics/git?project=X&limit=N
 *
 * Git event history. Returns empty since git events are in the Rust
 * agent's SQLite.
 */
export async function handleAnalyticsGit(
  _db: Db,
  url: URL,
): Promise<Response> {
  const _project = url.searchParams.get("project");
  const _limit = url.searchParams.get("limit");

  return new Response(
    JSON.stringify([]),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// GET /analytics/lifecycle
// ---------------------------------------------------------------------------

/**
 * GET /analytics/lifecycle?limit=N
 *
 * Agent lifecycle events. Returns empty since lifecycle events are
 * in the Rust agent's SQLite.
 */
export async function handleAnalyticsLifecycle(
  _db: Db,
  url: URL,
): Promise<Response> {
  const _limit = url.searchParams.get("limit");

  return new Response(
    JSON.stringify([]),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// GET /analytics/cron
// ---------------------------------------------------------------------------

/**
 * GET /analytics/cron?job=X&limit=N
 *
 * Cron job run history. Returns empty since cron run history is
 * in the Rust agent's SQLite.
 */
export async function handleAnalyticsCron(
  _db: Db,
  url: URL,
): Promise<Response> {
  const _job = url.searchParams.get("job");
  const _limit = url.searchParams.get("limit");

  return new Response(
    JSON.stringify([]),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
