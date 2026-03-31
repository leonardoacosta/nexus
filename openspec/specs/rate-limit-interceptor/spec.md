# rate-limit-interceptor Specification

## Purpose
TBD - created by archiving change add-credential-rotation. Update Purpose after archive.
## Requirements
### Requirement: The system SHALL detect and intercept rate limit events
The agent MUST detect rate limit events from sessions and MUST trigger credential rotation instead of delivering the notification.

#### Scenario: Socket notification with "hit your limit"
Given a session emits a SocketEvent::Notification containing "hit your limit"
And the credential pool has accounts with available capacity
When the notification reaches the socket handler
Then the notification is intercepted (not forwarded to TTS) and the rotation flow is triggered

#### Scenario: Rate limit event with utilization 1.0
Given a session emits a rate_limit_event with utilization >= 1.0
And the credential pool has accounts with available capacity
When the event is parsed
Then the rotation flow is triggered

#### Scenario: Passthrough when no credential pool
Given the credentials directory is empty or missing
When a rate limit notification arrives
Then it is delivered normally via TTS without interception

### Requirement: The system SHALL swap credentials via atomic symlink
The agent MUST atomically swap `~/.claude/.credentials.json` to point to the best available credential.

#### Scenario: Swap to best available
Given three credentials with utilizations 0.95, 0.30, 0.60
When rotation is triggered
Then the symlink is swapped to the credential with utilization 0.30

#### Scenario: Skip expired credentials
Given a credential has `expires_at` in the past
When selecting the best available
Then the expired credential is excluded from consideration

### Requirement: The system SHALL auto-continue sessions via tmux
After swapping credentials, the agent MUST send "continue" to the affected session.

#### Scenario: Auto-continue after swap
Given session A triggered the rate limit and has a tmux_target
When the credential swap completes
Then "continue" is sent to session A via `tmux send-keys`

#### Scenario: Session without tmux target
Given session A triggered the rate limit but has no tmux_target
When the credential swap completes
Then the swap still occurs but no "continue" is sent and a warning is logged

### Requirement: The system SHALL debounce across sessions
The system MUST debounce — sessions hitting limits within 3 minutes of a swap receive auto-continue without re-swapping.

#### Scenario: Second session hits limit during debounce
Given session A triggered a swap 1 minute ago (debounce active)
When session B hits a rate limit
Then session B receives "continue" immediately without querying usage or re-swapping

#### Scenario: Session hits limit after debounce expires
Given session A triggered a swap 4 minutes ago (debounce expired)
When session B hits a rate limit
Then a fresh usage query + swap cycle runs for session B

