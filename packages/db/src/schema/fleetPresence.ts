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

import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Structural stand-in for `@nexus/core`'s `PresenceVector`.
 *
 * `@nexus/core` depends on `@nexus/db` (workspace:*), so importing the real
 * `PresenceVector` type here would close a dependency cycle. We store the full
 * per-machine vector as opaque jsonb; the agent (which depends on both packages)
 * casts the deserialized value to `PresenceVector` at the read boundary — see
 * `apps/agent/src/services/fleet-presence.ts` (`resolveLiveConsoleVector`).
 */
export type FleetPresenceVector = Record<string, unknown>;

export const fleetPresence = pgTable(
  "fleet_presence",
  {
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
    /**
     * Full per-machine `PresenceVector` (every `PresenceField` with value +
     * confidence + `updatedAt`). The eval-path source for fleet-aware routing —
     * new presence fields never require a migration. Nullable for back-compat
     * with rows written before this column existed. Typed as opaque jsonb here
     * (circular-dep avoidance, see `FleetPresenceVector`); cast to
     * `PresenceVector` agent-side.
     */
    vector: jsonb("vector").$type<FleetPresenceVector>(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Live-console resolution (resolveLiveConsole / resolveLiveConsoleVector):
    // filter `on_console` rows, pick the newest `heartbeat`. Composite
    // (on_console, heartbeat) lets Postgres seek the on_console=true partition
    // and read heartbeat in order instead of scanning the whole table.
    index("fleet_presence_console_heartbeat_idx").on(
      table.onConsole,
      table.heartbeat,
    ),
  ],
);

export type FleetPresence = typeof fleetPresence.$inferSelect;
export type NewFleetPresence = typeof fleetPresence.$inferInsert;
