# Fleet-Aware Rules Evaluation — Phase 1.7

## Why

Activation of Phases 1-1.6 exposed a gap: the rules engine evaluates against the **firing
agent's local in-memory vector** (`manager.ts` → `decidePresenceRoute(flag,
this.presence.context.vector())`). On the headless homelab agent — where most Claude Code
sessions actually run — that vector has no Mac sensor of its own. It works today only by a happy
accident: the Mac's `nexus-presence` sensor POSTs to homelab's `/presence/report`, and the
single `userId`-keyed in-memory vector merges all reporters into one blob, so homelab's rules
engine happens to see the Mac's presence. Two Macs would clobber each other; `macHost` is
whoever-reported-last.

This phase makes evaluation genuinely **fleet-aware**: each machine's full presence is stored
**per-machine** in the shared `fleet_presence` table (as a jsonb vector), and when a notification
fires, the agent resolves the live-console machine and evaluates the rules against **that
machine's** vector — not its own local blob. This delivers true "follow me" routing for sessions
fired on ANY agent (incl. headless), handles N Macs without conflation, and fixes `nx-vbv39`
(remote `/presence/report` writes now persist a per-machine `fleet_presence` row instead of only
the local self-row).

## What Changes

- **`fleet_presence.vector` (jsonb)** — a new column holding the full `PresenceVector` for that
  machine (every `PresenceField` with value + confidence + `updatedAt`). New presence fields need
  no migration.
- **Per-machine vector model** — `presence-context.ts` maintains a per-machine vector map (keyed
  by the report's machine identity, each field TTL'd) instead of a single merged vector. Each
  reported machine's full vector is upserted to `fleet_presence` (vector jsonb + `on_console` +
  `mac_active`/`mac_locked` + `heartbeat`) on every report and heartbeat tick. This fixes
  `nx-vbv39`: a remote Mac reporting to the headless agent now persists ITS OWN `fleet_presence`
  row.
- **Resolved-console evaluation** — `fleet-presence.ts` gains `resolveLiveConsoleVector(db)`:
  resolve the newest `on_console` machine within the heartbeat TTL, deserialize its jsonb vector,
  and return it (or null when no live console). `manager.ts` evaluates the rules against this
  resolved vector (decision: whole vector from the live-console machine — single-user fleet, the
  phone co-reports with the console Mac). When no live console resolves, it falls back to the
  local vector + the existing all-unknown→legacy guard (no regression for single-machine fleets).
- **`GET /presence/fleet`** — enriched to return each machine's resolved presence + the
  live-console vector (the dashboard fleet indicator already consumes this endpoint).

**Decisions implemented:** full per-machine fleet-aware eval · vector stored as jsonb · eval the
whole vector from the resolved live-console machine · `nx-vbv39` folded in.

## Impact

- Affected capability: `context-aware-routing` (existing — completes fleet-aware routing)
- Behavioral change only when `presence_aware_routing` is ON (still default off): rules now
  evaluate against the live-console machine's presence, so a session fired on the headless agent
  routes by the Mac you're actually at. Single-machine fleets are unaffected (the local machine
  resolves as its own live console, or the all-unknown guard falls back to legacy).
- `fleet_presence` rows now carry a jsonb vector and are written for every reporting machine (not
  just the local self-row) — a superset of today's writes; the Phase 1.6 cross-machine delivery
  resolution (`resolveLiveConsole`) keeps working and now has correct multi-machine data.
- Migration via `pnpm --filter @nexus/db db:push`.

## Context
- depends on:
- touches: `packages/db/src/schema/fleetPresence.ts`, `apps/agent/src/notifications/presence-context.ts`, `apps/agent/src/services/fleet-presence.ts`, `apps/agent/src/routes/presence-report.ts`, `apps/agent/src/notifications/manager.ts`, `apps/agent/src/routes/presence-fleet.ts`, `apps/agent/src/services/fleet-presence.test.ts`, `apps/agent/src/notifications/presence-context.test.ts`, `apps/agent/src/notifications/manager-presence.test.ts`, `apps/agent/src/routes/presence-report.test.ts`
