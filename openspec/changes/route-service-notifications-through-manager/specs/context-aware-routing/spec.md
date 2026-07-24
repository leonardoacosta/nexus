## ADDED Requirements

### Requirement: Service-Originated Notifications MUST Route Through the Manager
The system MUST submit any `tts`/`desktop` `NotificationFired` event a service fires on its own
initiative (not in direct response to an inbound HTTP request already routed through
`NotificationManager.send()`) through the manager's gating path — meeting-hold, presence-aware
Rule 1, quiet hours, and rate throttle — rather than emitting directly onto the lifecycle bus.

#### Scenario: Ladder notification held during an active meeting
- **GIVEN** a meeting is active (`meetingState.active == true`)
- **AND** the credential-headroom ladder crosses a threshold, triggering a service notification
- **WHEN** the notification is submitted
- **THEN** it is held via the same durable held-queue path an HTTP-originated notification would
  use, and later flushed as part of the coalesced "N updates while you were in a meeting" summary

#### Scenario: Service notification respects quiet hours
- **GIVEN** quiet hours are active per the persisted routing settings
- **AND** a service (reaper-job, deploy-staleness, data-integrity-scan, credential-swap-flow, or
  the proactive-swap ladder) fires a `tts`-channel notification
- **WHEN** the notification is submitted
- **THEN** it is suppressed/deferred exactly as a quiet-hours-suppressed HTTP-originated
  notification would be

#### Scenario: Service notification with no project is never rate-throttled
- **GIVEN** a service notification carries no `project` field (the common case for these five
  sources)
- **WHEN** the notification is submitted through the manager
- **THEN** the rate-throttle check is skipped (matching `send()`'s existing project-less
  behavior) and the notification proceeds to delivery/hold evaluation
