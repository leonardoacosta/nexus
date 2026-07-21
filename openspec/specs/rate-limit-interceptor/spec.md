# rate-limit-interceptor Specification

## Purpose
TBD - created by archiving change add-credential-rotation. Update Purpose after archive.
## Requirements
### Requirement: The system SHALL detect and intercept rate limit events
The agent MUST detect rate-limit events from tracked sessions and trigger credential
rotation instead of delivering the notification. Detection runs in the socket-server
dispatcher's notification path and matches: (1) a CC `Notification` hook event whose
message contains a rate-limit phrase (at minimum "hit your limit" and "usage limit
reached", case-insensitive), and (2) a `rate_limit_event` payload with utilization >= 1.0.
When the credential pool has at least one eligible swap candidate, the notification MUST
be intercepted (not delivered to TTS or desktop channels) and the reactive rotation flow
triggered. When the pool is empty or no eligible candidate exists, the notification MUST
pass through to normal delivery and the exhaustion-handler path applies unchanged.

#### Scenario: Socket notification with "hit your limit"
Given a session emits a Notification hook event containing "hit your limit"
And the credential pool has accounts with available capacity
When the event reaches the dispatcher's notification path
Then the notification is intercepted (not forwarded to TTS/desktop) and the rotation flow is triggered

#### Scenario: Rate limit event with utilization 1.0
Given a session emits a rate_limit_event with utilization >= 1.0
And the credential pool has accounts with available capacity
When the event is parsed
Then the rotation flow is triggered

#### Scenario: Passthrough when no credential pool
Given the credential pool has no accounts
When a rate limit notification arrives
Then it is delivered normally via TTS without interception

#### Scenario: Passthrough when no eligible candidate
Given every pool account is at or beyond its usage limit
When a rate limit notification arrives
Then it is delivered normally and the exhaustion-handler ladder owns the response

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

### Requirement: The system MUST proactively rotate the active credential before exhaustion

On each successful usage-poller tick, the agent MUST evaluate the ACTIVE credential's
effective remaining headroom, defined as `min(5-hour remaining, 7-day remaining)`. The
moment effective remaining is at or below 2% (utilization of either window at or beyond
98%), the agent MUST swap to the eligible candidate with the most effective remaining
headroom via the pool's manual-swap primitive. Candidates with 2% or less effective
remaining are ineligible; any candidate above that line is eligible — accounts are used
to 98% before rotation, never abandoned early. The agent MUST NOT auto-swap if any swap
(manual or automatic) occurred within the last 10 minutes. Proactive swaps flow through
the same shared swap flow as reactive swaps (swap-tracker, `credential_swaps` row, audit,
notification).

#### Scenario: Active credential crossing 98% triggers swap to max-headroom candidate
- **GIVEN** the active credential has 1% effective remaining
- **AND** candidates A (60% effective remaining) and B (35%) are available and not in cooldown
- **WHEN** the poller tick completes
- **THEN** the pool swaps the active credential to candidate A
- **AND** audit entries and a `credential_swaps` row record the swap with an automatic actor

#### Scenario: Active credential below 98% utilization is untouched
- **GIVEN** the active credential has 9% of its 5h window remaining and 40% of its 7d window
- **WHEN** the poller tick completes
- **THEN** no swap is attempted — the account keeps burning down to the 98% line

#### Scenario: 7-day window can trigger the swap alone
- **GIVEN** the active credential has 30% of its 5h window remaining but 1% of its 7d window
- **AND** an eligible candidate exists
- **WHEN** the poller tick completes
- **THEN** the swap is triggered (effective remaining is the minimum across windows)

#### Scenario: Candidates at or below 2% are ineligible
- **GIVEN** the active credential has 1% effective remaining and every candidate has 2% or less
- **WHEN** the poller tick completes
- **THEN** no swap is attempted and the exhaustion ladder path is evaluated instead

#### Scenario: Recent swap suppresses auto-swap
- **GIVEN** the active credential has 1% effective remaining and an eligible candidate exists
- **AND** a swap occurred 5 minutes ago
- **WHEN** the poller tick completes
- **THEN** no swap is attempted this tick

#### Scenario: Cooldown target falls through to next candidate
- **GIVEN** the max-headroom candidate is in pool cooldown and a second eligible candidate exists
- **WHEN** the auto-swap is attempted
- **THEN** the swap falls through to the second candidate instead of failing

### Requirement: The system SHALL swap the active credential via the pool manual-swap primitive
The agent MUST swap `~/.claude/.credentials.json` to the best available credential via the
pool's manual-swap primitive (`pool.manualSwap()`), the same primitive the proactive
evaluator uses — there is exactly one swap implementation. Every swap, reactive or
proactive, MUST flow through a shared swap flow that records the swap-tracker timestamp,
inserts a `credential_swaps` row (from/to account, trigger session, reason), emits an
audit entry, and fires a `NotificationFired` ("swapped <from> → <to>") on tts and desktop
channels.

#### Scenario: Swap to best available
Given three credentials with utilizations 0.95, 0.30, 0.60
When rotation is triggered
Then the active credential is swapped to the credential with utilization 0.30

#### Scenario: Skip expired credentials
Given a credential has `expires_at` in the past
When selecting the best available
Then the expired credential is excluded from consideration

#### Scenario: Swap leaves a trace
Given a reactive swap from "personal" to "work" triggered by session "abc"
When the swap completes
Then a `credential_swaps` row records from="personal", to="work", session="abc", reason="reactive"
And a "swapped personal → work" notification fires on tts and desktop

