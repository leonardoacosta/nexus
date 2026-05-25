# notification-store

## ADDED Requirements

### Requirement: Notification Engine Reliability Guards

The notification engine SHALL reject invalid meeting state transitions and MUST bound the notification buffer so that buffer growth is capped under load.

#### Scenario: Invalid meeting transition rejected

- **WHEN** the meeting state machine receives a transition that is not permitted from its current state
- **THEN** the transition is rejected and logged, the current state is preserved, and no notification is emitted for the invalid transition

#### Scenario: Notification buffer overflow bounded

- **WHEN** the notification buffer reaches its configured maximum size and a new notification arrives
- **THEN** the buffer applies its overflow policy (drop or evict) so total buffered entries never exceed the maximum, and the overflow event is recorded

### Requirement: Channel Delivery Failure Visibility

External channel awaits SHALL be bounded by a timeout and the routing handler MUST surface a missing channel handler instead of silently skipping it.

#### Scenario: Hung channel times out

- **WHEN** an external channel API await in the router does not resolve within the configured timeout
- **THEN** the await is aborted via timeout, the failure is logged and captured, and delivery to other channels continues uninterrupted

#### Scenario: Missing channel handler surfaced

- **WHEN** the routing handler is asked to deliver to a channel that has no registered handler
- **THEN** the handler logs and captures the missing-handler condition rather than silently skipping it, so the lost delivery is observable
