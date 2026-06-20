/**
 * fleet_presence — shared-DB fleet presence store (one row per machine).
 *
 * Spec: openspec/changes/cross-machine-delivery (Phase 1.6).
 *
 * Every fleet agent already connects to the one homelab Postgres, so the shared
 * table IS the fleet picture — no gossip protocol. Each agent UPSERTs its OWN
 * row (`machine` PK) on presence change and on a heartbeat tick; any agent
 * SELECTs the full table to resolve the live-console machine via
 * newest-`heartbeat`-among-`on_console` (see
 * `apps/agent/src/services/fleet-presence.ts`).
 *
 * Clock-skew note: `heartbeat` is written using the DB's `now()` at write time
 * (server-authoritative), NOT each Mac's local clock, so the
 * newest-heartbeat tie-break is comparable across machines.
 */

import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const fleetPresence = pgTable("fleet_presence", {
  /** Machine name — one row per machine; each agent upserts its own. */
  machine: text("machine").primaryKey(),
  /** Whether this machine currently has a live console (user is at it). */
  onConsole: boolean("on_console").notNull().default(false),
  /** Mac sensor: an app is frontmost / the Mac is awake. Null = unknown. */
  macActive: boolean("mac_active"),
  /** Mac sensor: the screen is locked. Null = unknown. */
  macLocked: boolean("mac_locked"),
  /** Server-authoritative liveness stamp (DB now() at write); drives merge. */
  heartbeat: timestamp("heartbeat", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export type FleetPresence = typeof fleetPresence.$inferSelect;
export type NewFleetPresence = typeof fleetPresence.$inferInsert;
