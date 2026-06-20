# Design — Cross-Machine Delivery (Phase 1.6)

## Context

Completes the cross-machine promise deferred from Phase 1.5. Additive, still gated by
`presence_aware_routing` (default off). Reference: `docs/diagrams/presence-routing-research.html`
§2 (`macHost` / fleet-merge), §5 (data flow).

## Goals / Non-Goals

**Goals**
- Shared-DB fleet presence store + newest-heartbeat-among-on-console merge.
- Push-to-peer forward over Tailscale with lossless local fallback.
- A dashboard fleet-presence indicator.

**Non-Goals**
- No gossip / consensus protocol (the shared Postgres makes it unnecessary).
- No change to the Mac sensor or the rule set — only *where* `deliverTo:[mac]` lands.
- Multi-user fleet (still single-user, Q6).

## Key Decisions

### Shared Postgres IS the fleet store
Every fleet agent already connects to the one homelab Postgres. A `fleet_presence` table (one row
per machine) is the simplest correct fleet picture — each agent upserts its own row; any agent
SELECTs the fleet. This replaces the research doc's "presence gossip" with a table read. No new
network protocol.

### Push-to-peer forward, lossless fallback
When `resolveLiveConsole` returns a non-local machine, the originating agent POSTs to that peer's
`/notifications/deliver` (host:port from `agent-registry`). Lowest latency, direct. The peer emits
`NotificationFired` locally. If the POST fails, the originating agent delivers locally (you still
get the notification on the Mac the session is on) and logs warn — never dropped. The deliver
endpoint does NOT re-forward (loop guard).

### Merge / tie-break
`resolveLiveConsole(rows, localMachine)`: filter `on_console && heartbeat within TTL`; pick newest
`heartbeat`; empty → local. Pure function, unit-tested with fixtures. The `macHost` the rules
engine emits is reinterpreted at delivery time through this resolver (the rules engine itself is
unchanged — it still says `deliverTo:[mac]`; the manager resolves WHICH mac).

### Auth + reach
`/notifications/deliver` and `/presence/fleet` bind loopback + Tailscale only (same as every agent
route) and require `x-nexus-secret`. No new exposure surface beyond the existing agent API.

## Data Model

```text
fleet_presence (NEW)  machine text PK, on_console bool, mac_active bool, mac_locked bool,
                      heartbeat timestamptz, updated_at timestamptz
```

Migration via `pnpm --filter @nexus/db db:push`. No hand-written `.ts` migration.

## Data Flow

```text
each agent: PresenceObserver -> presence-context -> UPSERT fleet_presence(self)
notification fires on Mac A:
  manager -> resolveLiveConsole(SELECT fleet_presence) -> target machine
    target == A  -> NotificationFired (local)
    target == B  -> POST macB:7400/notifications/deliver -> B: NotificationFired
                    (fail -> NotificationFired local on A, warn)
dashboard: GET /presence/fleet -> FleetPresenceIndicator
```

## Risks / Trade-offs

- **Clock skew across Macs** affects newest-heartbeat tie-break. Mitigate: compare `heartbeat`
  using the DB's `now()` at write time (server-authoritative timestamp), not each Mac's clock.
- **Stale on_console** (a Mac that slept without clearing its row) → the heartbeat TTL filter
  excludes it; the heartbeat tick keeps live machines fresh.
- **Forward loop** — guarded: `/notifications/deliver` never re-routes.
- **Peer reachability** — lossless local fallback; a future enhancement could persist a
  DB-mediated row for the peer to claim on reconnect (out of scope this phase).
- **Swift build gate** needs the Mac awake (the fleet indicator). Agent batches (DB/API/E2E) are
  independently `bun test`-verifiable.
