## MODIFIED Requirements

### Requirement: nexus-ios SHALL embed SwiftTerm for in-app PTY attach

Tapping "Attach" on a session SHALL open a full-screen view rendering a SwiftTerm TerminalView. Behind it, an SSH client (SwiftNIO-SSH or libssh2) connects to the session's machine, runs `tmux attach -t <target>`, and pipes I/O to SwiftTerm. Every keystroke sent via `SshTerminalSession.send()` MUST reach the owning agent's `pty.write()` as a binary interact frame — a client-side "send success" log with no corresponding agent-side interact-frame receipt indicates a regression, not a passing state.

#### Scenario: attach to a homelab tmux session
- **GIVEN** a session `oo-7f3a` is running on homelab with tmux target `cc-oo:0.0`
- **WHEN** the user taps "Attach" in nexus-ios
- **THEN** within 3s a full-screen SwiftTerm view shows the live tmux pane output and accepts keyboard input

#### Scenario: keystrokes reach the agent's PTY (nx-qq3qu regression guard)
- **GIVEN** a single-`dashboardEndpoint`-mode agent owns session `oo-7f3a`
- **WHEN** `SshTerminalSession.send()` logs `NXPTY send bytes=N` and reports client-side success
- **THEN** the owning agent's log MUST show a corresponding `NXPTY interact binary -> pty.write()` entry for that session
- **AND** it MUST NOT show a `NXPTY interact binary DROPPED` entry for that keystroke

### Requirement: nexus-ios SHALL receive APNS push notifications

The app SHALL register for APNS push notifications via a real agent-side `/apns/register` endpoint. When the agent fires a `NotificationFired` event for a session whose app is not running/backgrounded, the agent SHALL dispatch an APNS push via HTTP/2 to the device. Tapping the push SHALL deep-link to the session detail. Local notifications already cover the running/backgrounded case; this requirement governs app-killed delivery only.

#### Scenario: push notification received and tappable
- **GIVEN** the iOS app is installed, signed in, APNS provisioned
- **WHEN** the agent fires NotificationFired for session `oo-7f3a`
- **THEN** within 2s the iPhone shows the push; tapping opens the `oo-7f3a` detail scene

#### Scenario: agent-side dispatch path actually exists (nx-q2u0d gap closure)
- **GIVEN** `ApnsRegistrar.swift` POSTs a device token to `{endpoint}/apns/register`
- **WHEN** that request is made
- **THEN** the agent responds with a non-404 success, storing the device token
- **AND** a subsequent `NotificationFired` event for a killed-app session results in an actual
  APNS HTTP/2 send from the agent, not a silent no-op

## ADDED Requirements

### Requirement: iOS HealthKit read and push to homelab mx-health ingest

The nexus-ios target SHALL read resting HR / HR / HRV via `HKAnchoredObjectQuery` with a
persisted incremental anchor, register `HKObserverQuery` + background delivery for
push-on-change, and POST the Health Auto Export JSON shape directly to the homelab mx-health
ingest endpoint (`http://homelab:8796/ingest`) over the tailnet — not routed through the nexus
agent. This is the production producer for `mx-sqd`/`mx-4d0` (mx repo), replacing the Health
Auto Export stopgap, and is distinct from nx's existing "health" (system metrics,
HealthSummaryScene/HealthCollector).

#### Scenario: HealthKit sample triggers a push to mx-health ingest

- **GIVEN** the user has granted HealthKit read authorization
- **AND** a new resting-HR sample is written by the Health app
- **WHEN** the registered `HKObserverQuery` background-delivery callback fires
- **THEN** the incremental `HKAnchoredObjectQuery` anchor advances past the new sample
- **AND** a POST in the Health Auto Export JSON shape is sent to
  `http://homelab:8796/ingest` over the tailnet
