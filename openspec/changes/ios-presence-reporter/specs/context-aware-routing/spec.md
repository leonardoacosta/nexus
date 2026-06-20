# Context-Aware Notification Routing

## ADDED Requirements

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
