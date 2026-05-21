## ADDED Requirements

### Requirement: nexus-watch SHALL be a native watchOS app target

A new watchOS app target `nexus-watch` SHALL be defined in `apps/swift/project.yml` and scaffolded under `apps/swift/nexus-watch/`. Target watchOS 10+. Links the `NexusShared` framework.

#### Scenario: watchOS target compiles
- **GIVEN** the target is defined and source files exist
- **WHEN** xcodebuild compiles the nexus-watch scheme
- **THEN** the .app is produced and runs on Watch simulator

### Requirement: nexus-watch SHALL display a compact session summary

The watchOS app SHALL show: active session count, the most recent alert (title + truncated body), updated via NexusClient SSE subscription forwarded through the paired iPhone.

#### Scenario: session count updates on RemoteSessionStarted
- **GIVEN** the watch is paired and showing 2 active sessions
- **WHEN** a new RemoteSessionStarted event arrives
- **THEN** the count updates to 3 within 2s

### Requirement: notification actions SHALL route back to CC as text commands

When the agent fires a permission-request style notification, the watch notification SHALL include action buttons (Approve / Deny / Custom). Tapping an action SHALL POST to a new agent endpoint `POST /commands/send-text {session_id, text}`. The agent SHALL deliver the text via `tmux send-keys` to the originating session.

#### Scenario: approve a destructive command from watch
- **GIVEN** CC asks "run `rm -rf .next/`?" via the Notification hook
- **WHEN** Leo taps "Approve" on his watch
- **THEN** within 2s the CC session receives "approve\n" via tmux send-keys and continues
