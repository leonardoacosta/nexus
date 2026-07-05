# exhaustion-handler Specification

## Purpose
TBD - created by archiving change add-credential-rotation. Update Purpose after archive.
## Requirements
### Requirement: The system SHALL notify when all accounts are exhausted
When all credentials are at capacity, the agent MUST send a detailed notification instead of silently failing.

#### Scenario: All accounts rate-limited
Given all credentials have utilization >= 1.0 for either 5h or 7d window
When a rate limit event is detected
Then a notification is sent listing each account name, limit type, and reset time, with the soonest-to-reset account highlighted

#### Scenario: Notification format
Given accounts "personal" (5h resets 2:15 PM), "work" (7d resets Thu), "team" (5h resets 1:45 PM)
When the exhaustion notification is generated
Then it reads:
```
All accounts rate-limited:
  personal: 5h resets 2:15 PM
  work: 7d resets Thu
  team: 5h resets 1:45 PM ← next available
```

#### Scenario: Single account only
Given only one credential exists and it is rate-limited
When a rate limit event is detected
Then the notification shows the single account's reset time without the "next available" marker

### Requirement: The system MUST emit graduated low-headroom notifications when no swap candidate exists

The agent MUST emit a `NotificationFired` lifecycle event on both `tts` and `desktop`
channels when the active credential's 5-hour remaining headroom is at or below 10%, no
eligible swap candidate exists (all candidates at or below 10% remaining), and the remaining
headroom crosses each of 10%, 8%, 4%, 2%, and 0%. Each threshold MUST fire at most once per
5-hour window (deduplicated by the window's reset instant). The notification message MUST
name the soonest-resetting account and its reset time.

#### Scenario: Threshold crossing fires once
- **GIVEN** no eligible swap candidate exists
- **AND** the active credential's remaining headroom drops from 11% to 9% between ticks
- **WHEN** the tick completes
- **THEN** the 10% and 8% notifications fire on tts and desktop, naming the soonest-resetting account
- **AND** subsequent ticks at 9% remaining fire nothing further

#### Scenario: New window resets the ladder
- **GIVEN** the 10% and 8% thresholds fired during the previous 5h window
- **WHEN** the window resets and remaining headroom later drops to 9% again
- **THEN** the 10% and 8% notifications fire again for the new window

#### Scenario: Ladder is suppressed while a swap candidate exists
- **GIVEN** the active credential has 9% remaining
- **AND** a candidate with 40% remaining is eligible
- **WHEN** the tick completes
- **THEN** the auto-swap runs and no ladder notification is emitted

#### Scenario: Zero-percent notification at full exhaustion
- **GIVEN** no eligible candidate exists and remaining headroom reaches 0%
- **WHEN** the tick completes
- **THEN** the 0% notification fires, naming the soonest-resetting account and reset time

