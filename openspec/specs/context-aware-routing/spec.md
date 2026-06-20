# context-aware-routing Specification

## Purpose
TBD - created by archiving change context-aware-routing. Update Purpose after archive.
## Requirements
### Requirement: Presence Vector Ingestion

The agent SHALL hold a per-user `PresenceVector` whose fields each carry a value, a source, an
`updatedAt` timestamp, and a confidence. Reporters SHALL update the vector via `POST
/presence/report`, and the existing meeting-state SHALL feed the `inMeeting` field. Any field
whose `updatedAt` is older than its TTL SHALL read as `unknown` rather than its last value.

#### Scenario: Reporter updates a presence field

- **WHEN** a `POST /presence/report` arrives with `{ macActive: true, macHost: "studio", updatedAt }`
- **THEN** the agent merges those fields into the user's `PresenceVector`
- **AND** emits a `PresenceChanged` lifecycle event with the updated vector

#### Scenario: Stale field reads as unknown

- **WHEN** a field's `updatedAt` is older than its TTL (mac fields ~30s)
- **THEN** reading that field returns `unknown` with confidence `unknown`
- **AND** the rules engine treats it per the staleness policy, never as the last reported value

#### Scenario: Meeting-state feeds the vector

- **WHEN** the existing meeting-state transitions to `active`
- **THEN** the vector's `inMeeting` field is set `true` with source `agent-cli`

### Requirement: Priority Rules Engine

The agent SHALL evaluate notifications against a priority-ordered list of `condition → action`
rules, first-match-wins. The engine SHALL replace the flat per-project `findMatchingRule` and
SHALL produce a closed `Action` (banner, ding, tts, deliverTo, deliveryMode, interruptionLevel,
collapseId, stopPropagation, holdUntil, digest, redact). When `presence_aware_routing` is
disabled, the engine SHALL fall back to the existing project + `meeting_behavior` routing with no
behavioral change.

#### Scenario: First matching rule wins

- **WHEN** a notification is evaluated and rules 1 and 2 both could match
- **THEN** the engine selects the higher-priority rule (lowest index) and ignores the rest

#### Scenario: Presence-aware routing disabled falls back

- **WHEN** `presence_aware_routing` is `false`
- **THEN** the engine routes using the legacy project + `meeting_behavior` logic
- **AND** produces the same channels today's `routeNotificationParallel` would

#### Scenario: No rule matches yields terminal fallback

- **WHEN** no presence rule matches (vector all-unknown)
- **THEN** the engine produces the terminal action `deliverTo: [dashboard], digest`
- **AND** the notification is never silently dropped

### Requirement: Active-Mac Rule

When the user is active on a Mac and not in a meeting, the engine SHALL deliver a banner and TTS
to the live host (`macHost`). This rule SHALL outrank the bedtime condition, so an active Mac
receives spoken delivery even during the bedtime window (decision Q1).

#### Scenario: Active Mac receives banner and TTS

- **WHEN** `macActive` is `true` and `inMeeting` is `false`
- **THEN** the action is `banner + tts`, `deliverTo: [macHost]`

#### Scenario: Active Mac at night still speaks

- **WHEN** `macActive` is `true`, `inMeeting` is `false`, and `isBedtime` is `true`
- **THEN** the active-Mac rule still wins and the action is `banner + tts`
- **AND** the bedtime rule does NOT suppress it

### Requirement: Meeting Hold Rule

When the user is present on a Mac and in a meeting, the engine SHALL hold the notification until a
configurable buffer (default 2 minutes) after the meeting ends, then deliver a coalesced summary.
A meeting SHALL be detected only when `(camera OR mic) AND (meeting-app OR calendar-busy)`
(decision Q2); camera-alone SHALL NOT hard-hold. If the meeting has no known end time, the hold
SHALL be capped at `now + 60m`.

#### Scenario: In-meeting notification is held and summarized

- **WHEN** `inMeeting` is `true` and a notification arrives
- **THEN** the notification is enqueued with `holdUntil = meetingEndsAt + buffer`
- **AND** on flush a single coalesced summary banner + TTS is delivered to `macHost`

#### Scenario: Unknown meeting end is capped

- **WHEN** `inMeeting` is `true` and `meetingEndsAt` is null
- **THEN** `holdUntil` is set to `now + 60m` as a safety cap

#### Scenario: Flush inside bedtime with idle Mac is silent

- **WHEN** a held batch flushes while `isBedtime` is `true` and `macActive` is `false`
- **THEN** the summary is delivered silently (no TTS), respecting the bedtime guard

### Requirement: Durable Held Queue

Held and digested notifications SHALL persist in a `presence_holds` table and survive agent
restart. On startup the agent SHALL reload pending holds and SHALL flush each at its `holdUntil`.
This replaces the in-memory meeting buffer.

#### Scenario: Held notifications survive restart

- **WHEN** a notification is held and the agent restarts before `holdUntil`
- **THEN** the hold is reloaded from `presence_holds` on startup
- **AND** is still flushed at its scheduled `holdUntil`

#### Scenario: Flushed holds are marked released

- **WHEN** a held notification is flushed
- **THEN** its `presence_holds` row is marked released
- **AND** a `PresenceHoldReleased` lifecycle event is emitted

### Requirement: Routing Settings Persistence

The `notification_settings` row SHALL gain `presence_aware_routing` (boolean, default false),
`unknown_noncritical_mode` (`fail-safe` | `fail-open`, default `fail-safe`), and
`unknown_critical_mode` (`fail-open` | `fail-safe`, default `fail-open`). Routing rules SHALL
persist in an ordered `routing_rules` table. Changes to either SHALL broadcast the existing
`SettingsChanged` lifecycle event so clients update without polling.

#### Scenario: Toggling presence-aware routing broadcasts

- **WHEN** a `PATCH /notifications/settings` sets `presence_aware_routing: true`
- **THEN** the row is updated and a `SettingsChanged` event is emitted
- **AND** the rules engine begins consulting the presence vector

#### Scenario: Rules persist in order

- **WHEN** rules are reordered via the settings API
- **THEN** their stored order in `routing_rules` reflects the new priority
- **AND** the engine evaluates them in that order

### Requirement: Mac Routing Settings Tab

The `nexus-mac` dashboard SHALL expose a `Routing` settings pane (a new case in `SettingsView`)
that lets the user toggle presence sources, choose the unknown-presence fail mode, view and
reorder the rules list, and run a what-wins simulator over a chosen presence vector. The pane
SHALL persist changes through the existing settings sync path.

#### Scenario: Simulator reports the winning rule

- **WHEN** the user sets the simulator inputs (e.g. mac locked, in meeting, phone idle)
- **THEN** the pane shows which rule wins and the resulting action

#### Scenario: Toggling a source persists to the agent

- **WHEN** the user toggles a presence source or the fail mode in the pane
- **THEN** the change is PATCHed to the agent and reflected after the `SettingsChanged` broadcast

### Requirement: Mac Presence Sensing Service

A dedicated headless `nexus-presence` LaunchAgent SHALL sense the local Mac's presence and POST
deltas to the local agent's `/presence/report`. It SHALL run independently of the `nexus-mac`
dashboard app (no Dock, no window) via launchd `RunAtLoad` + `KeepAlive`, bootstrapped into the
user's Aqua session (`gui/501`) so it can read CMIO camera/mic state. The sensing logic SHALL
live in a reusable `NexusShared` `PresenceObserver` so it is unit-testable.

#### Scenario: Sensor runs without the dashboard app

- **WHEN** the user is logged in and the `nexus-mac` dashboard app is NOT open
- **THEN** the `nexus-presence` LaunchAgent is running (RunAtLoad + KeepAlive)
- **AND** it continues reporting presence to the local agent

#### Scenario: Sensor reports lock and idle transitions

- **WHEN** the screen locks or HID idle crosses the active threshold
- **THEN** the sensor POSTs a presence delta setting `macLocked` / `macActive` accordingly

#### Scenario: Sensor is respawned after a crash

- **WHEN** the `nexus-presence` process exits unexpectedly
- **THEN** launchd `KeepAlive` restarts it
- **AND** sensing resumes without user action

### Requirement: Meeting Detection via Camera and Mic

The sensor SHALL detect a meeting using `(camera OR mic) IS-RUNNING-SOMEWHERE AND a frontmost
meeting app`, AND-gated so camera-alone (Photo Booth, Continuity Camera) does not trigger a hold
(decision Q2). When detected it SHALL set `inMeeting` true in the reported vector.

#### Scenario: Video call sets inMeeting

- **WHEN** the camera is in use AND a known meeting app is frontmost
- **THEN** the sensor reports `inMeeting: true`

#### Scenario: Camera-alone does not trigger a meeting

- **WHEN** the camera is in use but no meeting app is frontmost (e.g. Photo Booth)
- **THEN** the sensor does NOT report `inMeeting: true`

### Requirement: Tailscale Home Detection

The agent SHALL derive `phone_present` and `phone_home` by reading `tailscale status --json`: a
phone peer reachable via a LAN-range direct endpoint is `home`; a public address or DERP relay is
away; an absent/unreachable peer is `phone_present: false`. This SHALL require no iOS permission
and SHALL run on the always-on agent.

#### Scenario: LAN-direct peer is home

- **WHEN** the phone peer's current endpoint is a LAN-range (RFC1918) address on the agent's subnet
- **THEN** `phone_home` is `true` and `phone_present` is `true`

#### Scenario: Public or relayed peer is away

- **WHEN** the phone peer's endpoint is a public address or a DERP relay
- **THEN** `phone_home` is `false` and `phone_present` is `true`

#### Scenario: Unreachable peer is not present

- **WHEN** the phone peer is absent from `tailscale status` or unreachable
- **THEN** `phone_present` is `false` (and `phone_home` is `unknown`)

### Requirement: Presence Vector Phone Fields

The `PresenceVector` SHALL gain `phonePresent` and `phoneHome` (plus `macIdleSec` and `macFocus`),
each a TTL'd `PresenceField`. This SHALL be a non-breaking widening; existing Phase 1 consumers
SHALL be unaffected.

#### Scenario: Phone fields populate from Tailscale

- **WHEN** the Tailscale poller resolves the phone peer
- **THEN** `phonePresent` / `phoneHome` are set with source `derived` and a fresh `updatedAt`

#### Scenario: Stale phone fields read unknown

- **WHEN** the Tailscale poller has not refreshed within the phone-field TTL
- **THEN** `phonePresent` / `phoneHome` read `unknown`, and the staleness policy applies

### Requirement: Room-TTS Rule

The rules engine SHALL add Rule 4: `(NOT macActive OR macLocked) AND phonePresent AND phoneHome`
→ `{ tts, deliverTo:[macHost] }` (room-audible TTS on the local Mac). It SHALL evaluate after the
bedtime rule and before the phone-away rule, preserving the locked rule order.

#### Scenario: Locked Mac with phone home speaks into the room

- **WHEN** the Mac is locked, `phonePresent` and `phoneHome` are true, and it is not bedtime
- **THEN** Rule 4 wins and the action is `tts` to `macHost`

#### Scenario: Phone away does not trigger room-TTS

- **WHEN** the Mac is locked and `phoneHome` is false
- **THEN** Rule 4 does NOT match (falls through to a later rule)

#### Scenario: Unknown phone_home fails safe

- **WHEN** the Mac is locked and `phoneHome` is `unknown` for a non-critical notification
- **THEN** Rule 4 does NOT fire room-TTS; the notification fails safe (silent/digest)

