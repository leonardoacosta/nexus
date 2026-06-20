# Cross-Machine Delivery — Phase 1.6

## Why

Phases 1 + 1.5 (archived) made each agent route notifications by the *local* Mac's presence. But
the `macHost` field in the routing `Action` only ever names the agent's own machine — a
notification fired by a Claude Code session on Mac A always renders on Mac A, even when you're
sitting at Mac B. The "right surface" promise (the notification follows you to whichever Mac you
are actually at) is unfulfilled.

This phase delivers it. The enabler is already in place: every fleet agent connects to the same
homelab Postgres, so the **shared DB is the fleet presence store** — no gossip protocol. Each
agent writes its Mac's live-console state to a `fleet_presence` table; any agent reads the fleet
picture and resolves the live-console machine via newest-heartbeat-among-on-console. When the
resolved machine is a peer, the originating agent forwards the notification to that peer's agent
over Tailscale, which renders it locally.

## What Changes

- **`fleet_presence` table** — one row per machine (`machine`, `on_console`, `mac_active`,
  `mac_locked`, `heartbeat`/`updated_at`). Each agent upserts its own row on presence change and
  on a heartbeat tick.
- **Fleet merge** — `apps/agent/src/services/fleet-presence.ts` reads the table and resolves the
  live-console machine: the `on_console` row with the newest `heartbeat` wins; ties / all-stale →
  fall back to the local machine. Exposed as a pure function for testing.
- **Cross-machine forward** — when routing resolves a target machine that is NOT local, the
  originating agent POSTs the notification to the peer agent's `/notifications/deliver`
  (host:port from `agent-registry`, authed by the existing Tailscale bind + `x-nexus-secret`).
  The peer emits `NotificationFired` locally so its Mac renders the banner/TTS. **Fallback:** if
  the peer is unreachable, the originating agent delivers locally (lossless) and logs — no
  notification is ever dropped.
- **`POST /notifications/deliver`** — receives a forwarded notification on the target agent and
  emits `NotificationFired` into the local lifecycle bus (reuses the existing render path).
- **`GET /presence/fleet`** — returns the resolved fleet presence (machines + which is live) for
  the dashboard.
- **Fleet indicator (Swift)** — a small `nexus-mac` dashboard element showing the live-console
  machine and where the next notification will route ("notifications → this Mac" / "→ studio").

**Decisions implemented:** push-to-peer forward over Tailscale with local-delivery fallback ·
shared-DB fleet store (no gossip) · fleet-merge newest-heartbeat-among-on-console · dashboard
fleet indicator included.

## Impact

- Affected capability: `context-aware-routing` (existing — completes the cross-machine promise)
- New shared-DB table written by every fleet agent; new agent-to-agent HTTP hop on the tailnet
  (`/notifications/deliver`, secret-authed, loopback+Tailscale bind only — same reach constraint
  as every other agent route).
- Behavioral change only when `presence_aware_routing` is ON (still default off): a notification
  may now render on a different Mac than the one that fired it. Single-machine fleets are
  unaffected (the local machine is always the resolved target).
- No change to the Mac sensor or the rules engine's rule set — this phase changes only *where*
  `deliverTo:[mac]` lands.

## Context
- depends on:
- touches: `packages/db/src/schema/fleetPresence.ts`, `packages/db/src/schema/index.ts`, `apps/agent/src/services/fleet-presence.ts`, `apps/agent/src/notifications/presence-context.ts`, `apps/agent/src/notifications/manager.ts`, `apps/agent/src/notifications/cross-machine-delivery.ts`, `apps/agent/src/routes/notifications-deliver.ts`, `apps/agent/src/routes/presence-fleet.ts`, `apps/agent/src/db/agent-registry.ts`, `apps/agent/src/server-request-handler.ts`, `apps/swift/nexus-mac/Sources/Dashboard/FleetPresenceIndicator.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/agent/src/services/fleet-presence.test.ts`, `apps/agent/src/notifications/cross-machine-delivery.test.ts`, `apps/agent/src/routes/notifications-deliver.test.ts`, `apps/swift/nexus-mac/Tests/FleetPresenceIndicatorTests.swift`
