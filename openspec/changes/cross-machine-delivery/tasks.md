<!-- beads:epic:nx-i4sp1 -->
<!-- beads:feature:nx-xrh92 -->

# Tasks — Cross-Machine Delivery (Phase 1.6)

## DB Batch

- [x] Create `packages/db/src/schema/fleetPresence.ts` — `fleet_presence` table: `machine` text PK, `on_console` bool notNull default false, `mac_active` bool, `mac_locked` bool, `heartbeat` timestamptz notNull, `updated_at` timestamptz notNull defaultNow; export `$inferSelect`/`$inferInsert` types [beads:nx-cj1q7]
- [x] Export `fleetPresence` (+ types) from `packages/db/src/schema/index.ts` [beads:nx-7qntm]
- [x] Run `pnpm --filter @nexus/db db:push` against `POSTGRES_URL` and verify the table exists; handle the drizzle snapshot guard if it trips (no hand-written `.ts` migration) [beads:nx-2d9e5]

## API Batch

- [x] Create `apps/agent/src/services/fleet-presence.ts` — `upsertSelfPresence(db, machine, state)` writes the local row using the DB `now()` for `heartbeat` (server-authoritative, avoids cross-Mac clock skew); pure `resolveLiveConsole(rows, localMachine, ttlMs)` picks the newest `on_console` row within TTL, else the local machine [beads:nx-1054a]
- [x] Wire `apps/agent/src/notifications/presence-context.ts` to upsert the local `fleet_presence` row on presence change, and add a heartbeat tick that refreshes `heartbeat` even with no change [beads:nx-gdejc]
- [x] Create `apps/agent/src/notifications/cross-machine-delivery.ts` — `forwardOrLocal(notification, targetMachine, localMachine)`: if target is local, return false (deliver locally); else POST to the peer agent's `/notifications/deliver` (host:port via `agent-registry`, `x-nexus-secret`); on POST failure, return false (lossless local fallback) and log warn [beads:nx-qupnw]
- [x] Update `apps/agent/src/notifications/manager.ts` to resolve the target machine via `resolveLiveConsole` before delivering a `deliverTo:[mac]` action, and route through `forwardOrLocal` (forward when remote, local otherwise / on fallback) [beads:nx-8xkv9]
- [x] Create `apps/agent/src/routes/notifications-deliver.ts` — `POST /notifications/deliver`: require `x-nexus-secret`, validate the forwarded payload (400 on bad shape), emit `NotificationFired` on the local lifecycle bus, and NEVER re-route/re-forward (loop guard) [beads:nx-3fe23]
- [x] Create `apps/agent/src/routes/presence-fleet.ts` — `GET /presence/fleet`: return the fleet rows + the resolved live-console machine + the local machine name (for the dashboard) [beads:nx-skz0t]
- [x] Register `POST /notifications/deliver` and `GET /presence/fleet` in `apps/agent/src/server-request-handler.ts` (follow the existing `{method, path}` route list); read peer host:port in the forward path from `apps/agent/src/db/agent-registry.ts` [beads:nx-b01ip]

## UI Batch

- [ ] Add `fetchFleetPresence()` to `apps/swift/NexusShared/Networking/NexusClient.swift` (GET `/presence/fleet`, typed decode of machines + live console) [beads:nx-ewwvq]
- [ ] Create `apps/swift/nexus-mac/Sources/Dashboard/FleetPresenceIndicator.swift` — a compact dashboard element showing the live-console machine and the routing destination ("live console: studio", "notifications → this Mac"); refresh on appear / SSE [beads:nx-4vc67]

## E2E Batch

- [x] Create `apps/agent/src/services/fleet-presence.test.ts` — `resolveLiveConsole`: newest on-console wins, two on-console tie-break by heartbeat, no on-console → local, all-stale → local [beads:nx-sjqjk]
- [x] Create `apps/agent/src/notifications/cross-machine-delivery.test.ts` — local target → no forward; remote target → POST to peer; peer-unreachable → lossless local fallback + warn; no re-forward loop [beads:nx-qjejc]
- [x] Create `apps/agent/src/routes/notifications-deliver.test.ts` — valid forwarded payload + secret → `NotificationFired` + 2xx; bad shape → 400; missing secret → 401/403; never re-routes [beads:nx-u6q71]
- [ ] Create `apps/swift/nexus-mac/Tests/FleetPresenceIndicatorTests.swift` — indicator renders the resolved live-console machine + routing destination from a stubbed fleet response [beads:nx-f3w74]
