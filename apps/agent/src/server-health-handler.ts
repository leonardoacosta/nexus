/**
 * Health endpoint handlers extracted from server.ts.
 *
 * Encapsulates:
 * - Stubbed health payload (used while the collector is warming up)
 * - GET /health response builder
 * - POST /health/ingest body validation + snapshot insertion
 */

import os from "node:os";
import type { Db } from "@nexus/db";
import { getAgentId, logger } from "@nexus/core/node";
import type { HealthMetrics } from "@nexus/core";
import { insertHealthSnapshot, pingDb } from "./db/health";
import { lastWatcherTickMs } from "./services/process-watcher";
import { isSocketServerListening } from "./services/socket-server";
import { withCors } from "./server-origin";
import type { ServerState } from "./server-websocket";

/**
 * Stubbed health payload used while the collector is warming up.
 *
 * Liveness defaults are "healthy" because the only reason this payload is
 * returned is that the agent itself is up and serving requests — the
 * collector just hasn't ticked yet. The live path below overrides these
 * with the real subsystem signals as soon as they're available.
 */
export function stubbedHealthPayload(): HealthMetrics {
  return {
    hostname: os.hostname(),
    uptime_seconds: Math.floor(os.uptime()),
    cpu: { overall_percent: 0, per_core_percent: [], load_average: os.loadavg() },
    ram: { total_bytes: 0, used_bytes: 0, percent: 0 },
    disk: [],
    docker: null,
    db_ok: true,
    last_watcher_tick_ms: 0,
    socket_server_listening: true,
  };
}

/**
 * Handle GET /health — returns current metrics or a warming-up stub payload.
 *
 * Respects `?detail=true` to include optional network + processes fields.
 * Always wraps the response with CORS headers for Tailscale origins.
 *
 * Liveness composition: `db_ok`, `last_watcher_tick_ms`, and
 * `socket_server_listening` are computed under per-field try blocks. Each
 * field falls back to a documented sentinel on failure (false / -1 / false)
 * and the HTTP response stays 200 — the endpoint MUST NOT throw on
 * subsystem failure (see test-infrastructure spec § Health Endpoint
 * Liveness Fields).
 */
export async function handleHealthGet(
  request: Request,
  url: URL,
  state: ServerState,
  db?: Db,
): Promise<Response> {
  const detail = url.searchParams.get("detail") === "true";
  const latest = state.healthCollector.getLatest();

  let payload: HealthMetrics;
  let warmingUp = false;

  if (latest) {
    payload = { ...latest };
  } else {
    payload = stubbedHealthPayload();
    warmingUp = true;
  }

  // ── Liveness — per-field try blocks with documented fallbacks ───────────

  // db_ok: false on any failure (timeout, dead pool, refused, no Db).
  try {
    payload.db_ok = db ? await pingDb(db) : false;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "health: db_ok probe threw — falling back to false",
    );
    payload.db_ok = false;
  }

  // last_watcher_tick_ms: -1 sentinel means watcher hasn't ticked yet.
  try {
    payload.last_watcher_tick_ms = lastWatcherTickMs();
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "health: last_watcher_tick_ms probe threw — falling back to -1",
    );
    payload.last_watcher_tick_ms = -1;
  }

  // socket_server_listening: false when no server has started yet or after stop.
  try {
    payload.socket_server_listening = isSocketServerListening();
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "health: socket_server_listening probe threw — falling back to false",
    );
    payload.socket_server_listening = false;
  }

  // Strip optional detail fields when detail is not requested
  if (!detail) {
    delete payload.network;
    delete payload.processes;
  }

  const body = JSON.stringify(
    warmingUp ? { ...payload, _note: "warming up — metrics not yet collected" } : payload,
  );

  return withCors(
    request,
    new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/**
 * Handle POST /health/ingest — accept a HealthMetrics JSON body from the
 * Rust collector and persist a snapshot row.
 *
 * Returns 400 for invalid JSON / missing fields, 500 on insert failure,
 * 200 with `{ ok: true }` on success. Always wraps the response with CORS.
 */
export async function handleHealthIngest(request: Request, db: Db): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withCors(
      request,
      new Response(JSON.stringify({ error: "invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  // Basic shape validation
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).hostname !== "string" ||
    typeof (body as Record<string, unknown>).uptime_seconds !== "number" ||
    typeof (body as Record<string, unknown>).cpu !== "object" ||
    typeof (body as Record<string, unknown>).ram !== "object" ||
    !Array.isArray((body as Record<string, unknown>).disk)
  ) {
    return withCors(
      request,
      new Response(JSON.stringify({ error: "invalid body: missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  const metrics = body as HealthMetrics;

  // Weighted-average disk percent (same logic as health-scheduler)
  let diskPercent: number | null = null;
  if (metrics.disk.length > 0) {
    const totalBytes = metrics.disk.reduce((s, d) => s + d.total_bytes, 0);
    if (totalBytes > 0) {
      diskPercent = metrics.disk.reduce(
        (s, d) => s + (d.percent * d.total_bytes) / totalBytes,
        0,
      );
      diskPercent = Math.round(diskPercent * 10) / 10;
    } else {
      diskPercent = metrics.disk[0]?.percent ?? null;
    }
  }

  const snapshot = {
    timestamp: new Date(),
    // Agent identity matches `upsertSelfInRegistry` — resolved via
    // agents.toml (self_name) with os.hostname() fallback.
    agentId: getAgentId(),
    cpuPercent: (metrics.cpu as { overall_percent: number }).overall_percent,
    ramPercent: (metrics.ram as { percent: number }).percent,
    diskPercent,
    dockerContainers: metrics.docker?.containers ?? null,
    rawJson: JSON.stringify(metrics),
  };

  try {
    await insertHealthSnapshot(db, snapshot);
    return withCors(
      request,
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch (err) {
    logger.error({ err }, "health ingest: failed to insert snapshot");
    return withCors(
      request,
      new Response(JSON.stringify({ error: "internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
}
