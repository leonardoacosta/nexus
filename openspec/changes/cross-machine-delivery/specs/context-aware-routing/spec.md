# Context-Aware Notification Routing

## ADDED Requirements

### Requirement: Fleet Presence Store

Each agent SHALL write its own Mac's live-console state to a shared `fleet_presence` table
(one row per machine: `machine`, `on_console`, `mac_active`, `mac_locked`, `heartbeat`),
upserting on presence change and on a heartbeat tick. Because all fleet agents share one
Postgres, this table SHALL be the authoritative fleet picture — no peer-to-peer gossip.

#### Scenario: Agent upserts its own presence row

- **WHEN** the local Mac's presence changes (console/active/lock)
- **THEN** the agent upserts its `fleet_presence` row with a fresh `heartbeat`

#### Scenario: Heartbeat keeps the row fresh

- **WHEN** the heartbeat tick fires with no presence change
- **THEN** the agent still updates its row's `heartbeat` so staleness can be detected

### Requirement: Fleet Merge Resolves the Live Console

A pure `resolveLiveConsole(rows, localMachine)` SHALL pick the target machine: the `on_console`
row with the newest `heartbeat` wins. If no row is `on_console`, or all candidate rows are stale
past the heartbeat TTL, it SHALL fall back to the local machine. This resolves the `macHost` the
routing action delivers to.

#### Scenario: Newest on-console machine wins

- **WHEN** two machines report `on_console: true`
- **THEN** the one with the newest `heartbeat` is resolved as the live console

#### Scenario: No on-console falls back to local

- **WHEN** no machine reports `on_console` (or all are stale)
- **THEN** the resolved target is the local machine

### Requirement: Cross-Machine Forward

When routing resolves a target machine that is NOT the local machine, the originating agent SHALL
forward the notification to the target agent's `POST /notifications/deliver` (host:port from
`agent-registry`, authed by the existing `x-nexus-secret`). The target agent SHALL emit
`NotificationFired` locally so its Mac renders the banner/TTS. If the target is the local machine,
delivery SHALL proceed locally with no forward.

#### Scenario: Notification from Mac A renders on Mac B

- **WHEN** a notification fires on Mac A's agent and the resolved live console is Mac B
- **THEN** Mac A's agent POSTs it to Mac B's `/notifications/deliver`
- **AND** Mac B's agent emits `NotificationFired` and renders the banner/TTS

#### Scenario: Local target does not forward

- **WHEN** the resolved live console is the local machine
- **THEN** the notification is delivered locally with no HTTP forward

### Requirement: Forward Fallback Is Lossless

The agent SHALL deliver a notification locally and log the fallback whenever the forward POST to
the target peer fails (unreachable, timeout, non-2xx). A notification MUST NEVER be dropped
because a peer was unreachable.

#### Scenario: Unreachable peer falls back to local

- **WHEN** the forward POST to the target peer fails
- **THEN** the originating agent emits `NotificationFired` locally instead
- **AND** logs the fallback at warn

### Requirement: Deliver Endpoint

`POST /notifications/deliver` SHALL accept a forwarded notification payload, validate it
(400 on bad shape), require the `x-nexus-secret`, and emit `NotificationFired` on the local
lifecycle bus. It SHALL NOT re-route or re-forward (to prevent loops).

#### Scenario: Deliver endpoint renders a forwarded notification

- **WHEN** a valid forwarded notification arrives at `/notifications/deliver` with the secret
- **THEN** the agent emits `NotificationFired` locally and returns 2xx

#### Scenario: Deliver endpoint does not re-forward

- **WHEN** a notification is received at `/notifications/deliver`
- **THEN** it is rendered locally and NOT re-routed through cross-machine forward (no loop)

### Requirement: Fleet Presence Dashboard Indicator

The `nexus-mac` dashboard SHALL show a fleet-presence indicator: the resolved live-console
machine and where the next notification will route (e.g. "live console: studio",
"notifications → this Mac"). It SHALL read `GET /presence/fleet`.

#### Scenario: Indicator shows the live console

- **WHEN** the dashboard loads and the fleet resolves a live console
- **THEN** the indicator shows that machine name and the routing destination
