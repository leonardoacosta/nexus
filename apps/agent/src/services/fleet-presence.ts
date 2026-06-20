/**
 * Fleet-presence service (openspec/changes/cross-machine-delivery, Phase 1.6).
 *
 * Two halves:
 *
 *  - `upsertSelfPresence` — writes the LOCAL machine's `fleet_presence` row.
 *    The `heartbeat` is stamped with the DB's `now()` (server-authoritative),
 *    NOT a JS `new Date()`, so the newest-heartbeat tie-break in
 *    `resolveLiveConsole` is comparable across Macs with skewed clocks (see the
 *    clock-skew risk in design.md).
 *
 *  - `resolveLiveConsole` — a PURE merge over a snapshot of `fleet_presence`
 *    rows: the `on_console` row with the newest `heartbeat` within `ttlMs`
 *    wins; if no candidate qualifies (none on-console, or all stale past TTL),
 *    it falls back to the local machine. Pure = unit-testable with plain
 *    fixtures; the manager calls it with a fresh SELECT before each delivery.
 */

import type { Db, FleetPresence, FleetPresenceVector } from "@nexus/db";
import { fleetPresence, sql } from "@nexus/db";
import type { PresenceVector } from "@nexus/core";

/** Default heartbeat TTL — mirrors the volatile mac-field TTL (~30s). */
export const FLEET_HEARTBEAT_TTL_MS = 30_000;

/** The presence fields an agent reports for its own machine. */
export interface SelfPresenceState {
  onConsole: boolean;
  macActive?: boolean | null;
  macLocked?: boolean | null;
  /**
   * The FULL per-machine presence vector (fleet-aware-rules-eval, Phase 1.7).
   * Serialized to the `vector` jsonb column so the eval path
   * (`resolveLiveConsoleVector`) can read every `PresenceField` without a
   * per-field migration. Written from the SAME vector that produced the typed
   * `onConsole`/`macActive`/`macLocked` columns so the two cannot diverge.
   * Omitted/undefined leaves the jsonb untouched on update (back-compat).
   */
  vector?: PresenceVector | null;
}

/**
 * UPSERT the local machine's `fleet_presence` row. The `heartbeat` is written
 * with the DB's `now()` (server-authoritative) so cross-Mac clock skew never
 * corrupts the newest-heartbeat tie-break. Called on presence change and on the
 * heartbeat tick.
 *
 * When `state.vector` is provided, the full per-machine `PresenceVector` is
 * serialized into the `vector` jsonb column ALONGSIDE the typed columns, from
 * the same source vector, so the eval-path jsonb and the
 * delivery-path typed columns are written atomically and cannot drift.
 */
export async function upsertSelfPresence(
  db: Db,
  machine: string,
  state: SelfPresenceState,
): Promise<void> {
  // Cast the typed PresenceVector to the db package's opaque jsonb shape. The
  // circular dep prevents @nexus/db from importing PresenceVector, so the
  // boundary cast lives here (the agent depends on both packages).
  const vectorJson: FleetPresenceVector | undefined =
    state.vector === undefined
      ? undefined
      : (state.vector as unknown as FleetPresenceVector | null) ?? undefined;

  const values = {
    machine,
    onConsole: state.onConsole,
    macActive: state.macActive ?? null,
    macLocked: state.macLocked ?? null,
    ...(vectorJson !== undefined ? { vector: vectorJson } : {}),
    // Server-authoritative stamps — NOT a JS clock.
    heartbeat: sql`now()`,
    updatedAt: sql`now()`,
  };

  await db
    .insert(fleetPresence)
    .values(values as never)
    .onConflictDoUpdate({
      target: fleetPresence.machine,
      set: {
        onConsole: values.onConsole,
        macActive: values.macActive,
        macLocked: values.macLocked,
        ...(vectorJson !== undefined ? { vector: vectorJson } : {}),
        heartbeat: sql`now()`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Resolve the live-console machine for a `deliverTo:[mac]` action.
 *
 * Filter to `on_console` rows whose `heartbeat` is within `ttlMs` of `nowMs`;
 * pick the newest `heartbeat`. If no row qualifies, fall back to `localMachine`
 * (lossless — the notification still renders where it fired).
 *
 * @param nowMs Injectable clock for deterministic tests; defaults to Date.now().
 */
export function resolveLiveConsole(
  rows: readonly FleetPresence[],
  localMachine: string,
  ttlMs: number = FLEET_HEARTBEAT_TTL_MS,
  nowMs: number = Date.now(),
): string {
  let best: FleetPresence | null = null;
  for (const r of rows) {
    if (!r.onConsole) continue;
    const hb = r.heartbeat instanceof Date ? r.heartbeat.getTime() : new Date(r.heartbeat).getTime();
    if (nowMs - hb > ttlMs) continue; // stale past TTL
    if (best === null) {
      best = r;
      continue;
    }
    const bestHb =
      best.heartbeat instanceof Date
        ? best.heartbeat.getTime()
        : new Date(best.heartbeat).getTime();
    if (hb > bestHb) best = r;
  }
  return best?.machine ?? localMachine;
}

/**
 * Pick the live-console row (newest `on_console` `heartbeat` within `ttlMs`) and
 * return its deserialized `PresenceVector` (fleet-aware-rules-eval, Phase 1.7).
 *
 * PURE over the row snapshot — unit-testable with plain fixtures. Returns null
 * when NO machine is on-console within the TTL, or when the resolved row's
 * `vector` jsonb is null (a row written before the jsonb column existed, or by
 * an older agent). The jsonb is opaque (`FleetPresenceVector`); we cast it to
 * `PresenceVector` here at the read boundary — the same machine that wrote it
 * serialized a real vector, so the cast is sound.
 *
 * Reuses the `resolveLiveConsole` selection logic (newest-heartbeat-among-
 * on-console-within-TTL) but with a sentinel: when no candidate qualifies it
 * returns null rather than falling back to a machine name (the eval path wants
 * "no live console" to be explicit so the manager can fall back to the local
 * vector + the all-unknown guard).
 */
export function resolveLiveConsoleVector(
  rows: readonly FleetPresence[],
  ttlMs: number = FLEET_HEARTBEAT_TTL_MS,
  nowMs: number = Date.now(),
): PresenceVector | null {
  let best: FleetPresence | null = null;
  for (const r of rows) {
    if (!r.onConsole) continue;
    const hb =
      r.heartbeat instanceof Date ? r.heartbeat.getTime() : new Date(r.heartbeat).getTime();
    if (nowMs - hb > ttlMs) continue; // stale past TTL
    if (best === null) {
      best = r;
      continue;
    }
    const bestHb =
      best.heartbeat instanceof Date
        ? best.heartbeat.getTime()
        : new Date(best.heartbeat).getTime();
    if (hb > bestHb) best = r;
  }
  if (best === null || best.vector == null) return null;
  return best.vector as unknown as PresenceVector;
}

/**
 * DB-backed variant: SELECT the full `fleet_presence` snapshot and resolve the
 * live-console machine's vector via the pure `resolveLiveConsoleVector` above.
 * Used by the manager (eval path) and `GET /presence/fleet` (endpoint
 * enrichment). Returns null when no live console resolves OR when its vector is
 * null — the caller falls back to the local in-memory vector.
 */
export async function resolveLiveConsoleVectorFromDb(
  db: Db,
  ttlMs: number = FLEET_HEARTBEAT_TTL_MS,
): Promise<PresenceVector | null> {
  const rows = await db.select().from(fleetPresence);
  return resolveLiveConsoleVector(rows, ttlMs);
}
