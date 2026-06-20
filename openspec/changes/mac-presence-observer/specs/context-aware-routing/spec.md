# Context-Aware Notification Routing

## ADDED Requirements

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
