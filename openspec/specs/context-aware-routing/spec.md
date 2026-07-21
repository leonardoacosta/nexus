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

The sensor SHALL detect a meeting using `(camera OR mic) IS-RUNNING-SOMEWHERE AND a known
meeting app is RUNNING (present in the list of currently-running applications)`, AND-gated so
camera-alone (Photo Booth, Continuity Camera) does not trigger a hold (decision Q2). The meeting
app is no longer required to be frontmost — it need only be open. When detected it SHALL set
`inMeeting` true in the reported vector.

#### Scenario: Video call sets inMeeting

- **WHEN** the camera is in use AND a known meeting app is running
- **THEN** the sensor reports `inMeeting: true`

#### Scenario: Meeting continues after focus moves away

- **WHEN** the camera or mic is in use, a known meeting app is running, but the frontmost app is
  something else (e.g. a terminal or editor)
- **THEN** the sensor still reports `inMeeting: true`

#### Scenario: Camera-alone does not trigger a meeting

- **WHEN** the camera is in use but no meeting app is running (e.g. Photo Booth)
- **THEN** the sensor does NOT report `inMeeting: true`

#### Scenario: Meeting app open but idle does not trigger a meeting

- **WHEN** a known meeting app is running but neither the camera nor the mic is in use
- **THEN** the sensor does NOT report `inMeeting: true`

#### Scenario: Meeting ends when the app quits or devices go idle

- **WHEN** the meeting app is no longer running, or both the camera and mic stop being in use
- **THEN** the sensor reports `inMeeting: false` on the next delta

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

### Requirement: iOS Presence Reporter

The nexus-ios app SHALL report phone presence signals — an HK-sleep-window flag, a Sleep-Focus
flag, and a general `phoneFocusOn` flag — to the homelab agent's `/presence/report` over
Tailscale. Reporting SHALL be event-driven (HealthKit observer wake, Focus-status change,
foreground) within iOS background-execution limits, never polling. It SHALL reuse the existing
APNs registration and HealthKit background-delivery infrastructure.

#### Scenario: Focus change reports to the agent

- **WHEN** the phone's Focus status changes (a Focus is enabled or disabled)
- **THEN** the reporter POSTs the updated `phoneFocusOn` (and sleep-focus) signal to `/presence/report`

#### Scenario: Sleep-window evaluation reports bedtime signal

- **WHEN** the HealthKit sleep schedule indicates the current time is in (or out of) the sleep window
- **THEN** the reporter reports the HK-sleep-window flag to the agent

#### Scenario: Reporter does not poll in the background

- **WHEN** the app is backgrounded
- **THEN** the reporter only emits on an OS-delivered wake (HK observer, Focus change) or foreground, not a timer

### Requirement: Configurable Bedtime Sources

The agent SHALL compute `isBedtime` from the phone's reported HK-sleep-window and Sleep-Focus
signals according to a `bedtime_sources` setting (`hk` | `focus` | `either` | `both`, default
`either`). The phone reports the raw signals; the agent applies the policy, so the toggle lives in
one place.

#### Scenario: Either source triggers bedtime

- **WHEN** `bedtime_sources` is `either` and the HK sleep window is active (Sleep Focus off)
- **THEN** `isBedtime` is true

#### Scenario: Both sources required

- **WHEN** `bedtime_sources` is `both` and only one of HK-window / Sleep-Focus is active
- **THEN** `isBedtime` is false

#### Scenario: Single source selected

- **WHEN** `bedtime_sources` is `focus`
- **THEN** `isBedtime` follows the Sleep-Focus signal only, ignoring the HK window

### Requirement: Global Phone-Field Overlay

The agent SHALL overlay the freshest global phone fields (`isBedtime`, `phoneFocusOn`) onto the
resolved eval vector before evaluating the rules — because those fields are global to the single
phone while rule evaluation runs against the live-console machine's vector (Phase 1.7). A stale
phone field past its TTL MUST read `unknown` and not override.

#### Scenario: Phone bedtime applies regardless of console machine

- **WHEN** the live console is a Mac and the phone has reported `isBedtime: true` within TTL
- **THEN** the eval vector used for the rules has `isBedtime: true` overlaid from the phone

#### Scenario: Stale phone field does not override

- **WHEN** the phone's `isBedtime` is older than its TTL
- **THEN** it reads `unknown` and does not force a bedtime decision

### Requirement: Bedtime Rule

The rules engine SHALL add Rule 3: `is_bedtime AND NOT mac_active` → a silent delivery (banner,
no ding, no tts, passive interruption, deliver to phone). It SHALL evaluate after the meeting-hold
rule and before the room-TTS rule, so an active Mac (Rule 1) still beats bedtime per the locked
ordering (Q1).

#### Scenario: Bedtime with idle Mac delivers silently

- **WHEN** `is_bedtime` is true and `mac_active` is false
- **THEN** Rule 3 wins: a silent passive banner to the phone, no tts/ding

#### Scenario: Active Mac beats bedtime

- **WHEN** `is_bedtime` is true but `mac_active` is true
- **THEN** Rule 1 (active Mac) wins and Rule 3 does not fire

### Requirement: Focus Respect

When `phoneFocusOn` is true, the agent SHALL drop a non-critical delivery to the `passive`
interruption level (respecting the user's Focus), without otherwise changing the matched rule's
channels.

#### Scenario: Focus active lowers interruption

- **WHEN** a non-critical notification matches a rule and `phoneFocusOn` is true
- **THEN** the delivered action's interruption level is `passive`

### Requirement: Communication Notifications Entitlement

The nexus-ios entitlements SHALL include `com.apple.developer.usernotifications.communication` so
`INFocusStatusCenter` authorization succeeds and the build signs on-device (the Apple Developer
portal capability is already granted).

#### Scenario: Entitlement present for Focus authorization

- **WHEN** the app requests `INFocusStatusCenter` authorization
- **THEN** the entitlement is present and authorization can proceed

