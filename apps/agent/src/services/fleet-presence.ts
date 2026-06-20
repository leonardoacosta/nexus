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

import type { Db, FleetPresence } from "@nexus/db";
import { fleetPresence, sql } from "@nexus/db";

/** Default heartbeat TTL — mirrors the volatile mac-field TTL (~30s). */
export const FLEET_HEARTBEAT_TTL_MS = 30_000;

/** The presence fields an agent reports for its own machine. */
export interface SelfPresenceState {
  onConsole: boolean;
  macActive?: boolean | null;
  macLocked?: boolean | null;
}

/**
 * UPSERT the local machine's `fleet_presence` row. The `heartbeat` is written
 * with the DB's `now()` (server-authoritative) so cross-Mac clock skew never
 * corrupts the newest-heartbeat tie-break. Called on presence change and on the
 * heartbeat tick.
 */
export async function upsertSelfPresence(
  db: Db,
  machine: string,
  state: SelfPresenceState,
): Promise<void> {
  const values = {
    machine,
    onConsole: state.onConsole,
    macActive: state.macActive ?? null,
    macLocked: state.macLocked ?? null,
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
