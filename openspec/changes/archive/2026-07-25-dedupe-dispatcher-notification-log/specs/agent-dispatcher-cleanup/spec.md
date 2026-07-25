# Agent Dispatcher Cleanup

## ADDED Requirements

### Requirement: Notification delivery emits exactly one structured log line

The dispatcher SHALL emit exactly one `"socket: notification"` structured INFO line per delivered notification, regardless of whether delivery is immediate or deferred through the rate-limit path.

#### Scenario: Immediate delivery logs once

- **WHEN** a notification event is dispatched on the common (non-rate-limit) path
- **THEN** exactly one `"socket: notification"` INFO line is emitted

#### Scenario: Deferred delivery logs once

- **WHEN** a notification is deferred by the reactive rate-limit swap path and later delivered
- **THEN** exactly one `"socket: notification"` INFO line is emitted for it
