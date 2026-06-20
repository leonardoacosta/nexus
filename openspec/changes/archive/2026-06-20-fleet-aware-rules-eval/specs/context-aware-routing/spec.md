# Context-Aware Notification Routing

## ADDED Requirements

### Requirement: Per-Machine Presence Storage

The agent SHALL store each reporting machine's full `PresenceVector` per-machine in the
`fleet_presence` table, including a `vector` jsonb column holding every `PresenceField` (value,
confidence, `updatedAt`). A report received from a remote machine SHALL persist a `fleet_presence`
row keyed by that machine, not only the local self-row.

#### Scenario: Remote report persists a per-machine row

- **WHEN** a remote Mac POSTs its presence to a headless agent's `/presence/report`
- **THEN** the agent upserts a `fleet_presence` row keyed by that Mac's machine identity
- **AND** the row's `vector` jsonb contains the Mac's full presence vector

#### Scenario: Local self-row still written

- **WHEN** the local machine's presence changes or the heartbeat tick fires
- **THEN** the local machine's `fleet_presence` row (vector + on_console + heartbeat) is upserted

#### Scenario: New presence fields need no migration

- **WHEN** the `PresenceVector` gains a new field in a later phase
- **THEN** it serializes into the existing `vector` jsonb with no schema migration

### Requirement: Live-Console Vector Resolution

A pure-ish `resolveLiveConsoleVector(db)` SHALL resolve the live-console machine (the newest
`on_console` row within the heartbeat TTL) and return that machine's deserialized
`PresenceVector`. When no machine is `on_console` (or all are stale), it SHALL return null.

#### Scenario: Newest on-console machine's vector wins

- **WHEN** two machines report `on_console: true`
- **THEN** `resolveLiveConsoleVector` returns the vector of the one with the newest `heartbeat`

#### Scenario: No live console returns null

- **WHEN** no machine is `on_console` within the TTL
- **THEN** `resolveLiveConsoleVector` returns null

### Requirement: Fleet-Aware Rule Evaluation

When `presence_aware_routing` is enabled, the agent SHALL evaluate the routing rules against the
resolved live-console machine's vector rather than the firing agent's local in-memory vector.
When `resolveLiveConsoleVector` returns null, it SHALL fall back to the local vector subject to
the existing all-unknown→legacy guard, so single-machine fleets and no-presence cases are
unchanged.

#### Scenario: Session on headless agent routes by the live Mac

- **WHEN** a notification fires on the headless agent and a Mac is the resolved live console with
  `macActive: true`
- **THEN** the rules evaluate against the Mac's vector and Rule 1 (active-Mac banner + TTS) fires

#### Scenario: No live console falls back to local + guard

- **WHEN** `resolveLiveConsoleVector` returns null and the local vector is all-unknown
- **THEN** routing falls back to the legacy path (the all-unknown guard), with no presence digest

#### Scenario: Single-machine fleet unchanged

- **WHEN** the only reporting machine is the local machine and it is the live console
- **THEN** evaluation against the resolved vector matches evaluation against the local vector

### Requirement: Fleet Presence Endpoint Enrichment

`GET /presence/fleet` SHALL return, in addition to the machine list and resolved live-console
machine, the live-console machine's resolved presence vector (or an indication that none
resolved), for the dashboard fleet indicator.

#### Scenario: Endpoint returns the resolved console vector

- **WHEN** a machine is the resolved live console
- **THEN** `GET /presence/fleet` includes that machine's resolved vector alongside `liveConsole`
