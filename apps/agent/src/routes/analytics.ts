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
import { and, desc, eq, gte, type SQL } from "drizzle-orm";
import { queryHealthTimeSeries } from "../db/health";
import { createLogger } from "@nexus/core/node";
import type {
  AnalyticsNotificationRow,
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

/**
 * GET /analytics/notifications?hours=N&project=X&status=Y
 *
 * Query the `notifications` table with optional filters. Defaults to the
 * trailing 24 hours and no project/status filter. Returns an envelope with
 * the matched rows plus the effective filter shape so consumers can render
 * "showing N over the last H hours for project=X" without re-parsing the
 * request.
 *
 * Spec: analytics-query-and-tts-synthesis. Returns HTTP 200 with an empty
 * `rows: []` when nothing matches — never 404 (path matched; empty-set has
 * its own contract).
 */
export async function handleAnalyticsNotifications(
  db: Db,
  url: URL,
): Promise<Response> {
  const hoursParam = url.searchParams.get("hours");
  const projectParam = url.searchParams.get("project");
  const statusParam = url.searchParams.get("status");

  const hours = hoursParam ? Number(hoursParam) : 24;
  if (Number.isNaN(hours) || hours <= 0) {
    return new Response(
      JSON.stringify({ error: "hours must be a positive number" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const cutoff = new Date(Date.now() - hours * 3600_000);
  const conditions: SQL[] = [gte(notificationsTable.createdAt, cutoff)];
  if (projectParam) conditions.push(eq(notificationsTable.project, projectParam));
  if (statusParam) conditions.push(eq(notificationsTable.status, statusParam));

  try {
    const rows = await db
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
      })
      .from(notificationsTable)
      .where(and(...conditions))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(500);

    const payload: AnalyticsNotificationRow[] = rows.map((r) => ({
      id: r.id,
      channel: r.channel as NotificationChannel,
      title: r.title,
      body: r.body,
      project: r.project,
      priority: r.priority as NotificationPriority,
      status: r.status as NotificationStatus,
      severity: r.severity as NotificationSeverity,
      delivery_state: r.deliveryState as NotificationDeliveryState,
      created_at:
        r.createdAt instanceof Date
          ? r.createdAt.toISOString()
          : (r.createdAt as unknown as string),
      sent_at:
        r.sentAt instanceof Date
          ? r.sentAt.toISOString()
          : (r.sentAt as unknown as string | null) ?? null,
    }));

    return new Response(
      JSON.stringify({
        rows: payload,
        count: payload.length,
        hours,
        filters: {
          project: projectParam,
          status: statusParam,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
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
