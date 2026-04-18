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
import { queryHealthTimeSeries } from "../db/health";
import { createLogger } from "@nexus/core/node";

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
