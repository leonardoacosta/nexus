/**
 * Health route builders for the nexus-agent HTTP API.
 *
 * - GET  /health           — latest collected metrics (with warming-up stub)
 * - POST /health/ingest    — remote agent pushes its metrics snapshot
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 */

import type { Db } from "@nexus/db";
import type { HealthMetrics } from "@nexus/core";
import { getAgentId, logger } from "@nexus/core/node";
import os from "node:os";
import type { Route } from "../router";
import type { ServerState } from "../server-websocket";
import { insertHealthSnapshot } from "../db/health";

/** Stubbed health payload used while the collector is warming up. */
function stubbedHealthPayload(): HealthMetrics {
  return {
    hostname: os.hostname(),
    uptime_seconds: Math.floor(os.uptime()),
    cpu: { overall_percent: 0, per_core_percent: [], load_average: os.loadavg() },
    ram: { total_bytes: 0, used_bytes: 0, percent: 0 },
    disk: [],
    docker: null,
  };
}

/**
 * Build the health route table.
 *
 * `dbRef` is a pre-cast non-optional Db reference captured in the routes.ts
 * orchestrator; when this builder is called with `db = undefined`, any
 * requiresDb routes are skipped by the router's DB guard so the closure is
 * never invoked.
 */
export function buildHealthRoutes(state: ServerState, db?: Db): Route[] {
  const dbRef = db as Db;

  return [
    // ── Health ─────────────────────────────────────────────────────────────
    {
      method: "GET",
      path: "/health",
      requiresAuth: true,
      handler(req) {
        const url = new URL(req.url);
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

        if (!detail) {
          delete payload.network;
          delete payload.processes;
        }

        const body = JSON.stringify(
          warmingUp ? { ...payload, _note: "warming up — metrics not yet collected" } : payload,
        );

        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },

    // ── Health ingest (requires DB) ────────────────────────────────────────
    {
      method: "POST",
      path: "/health/ingest",
      requiresDb: true,
      async handler(req) {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response(JSON.stringify({ error: "invalid JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (
          typeof body !== "object" ||
          body === null ||
          typeof (body as Record<string, unknown>).hostname !== "string" ||
          typeof (body as Record<string, unknown>).uptime_seconds !== "number" ||
          typeof (body as Record<string, unknown>).cpu !== "object" ||
          typeof (body as Record<string, unknown>).ram !== "object" ||
          !Array.isArray((body as Record<string, unknown>).disk)
        ) {
          return new Response(JSON.stringify({ error: "invalid body: missing required fields" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const metrics = body as HealthMetrics;

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
          await insertHealthSnapshot(dbRef, snapshot);
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          logger.error({ err }, "health ingest: failed to insert snapshot");
          return new Response(JSON.stringify({ error: "internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  ];
}
