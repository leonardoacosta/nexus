# exhaustion-handler — Delta

## MODIFIED Requirements

### Requirement: The system MUST emit graduated low-headroom notifications when no swap candidate exists

The agent MUST emit a `NotificationFired` lifecycle event on both `tts` and `desktop`
channels when the active credential's 5-hour remaining headroom is at or below 10%, no
eligible swap candidate exists (all candidates at or below 2% effective remaining — 98%
utilization or beyond on either window), and the remaining headroom crosses each of 10%,
8%, 4%, 2%, and 0%. Each threshold MUST fire at most once per 5-hour window (deduplicated
by the window's reset instant). The notification message MUST name the soonest-resetting
account and its reset time.

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
- **AND** a candidate with 40% effective remaining is eligible
- **WHEN** the tick completes
- **THEN** no ladder notification is emitted and no swap runs yet — the proactive swap
  fires when the active credential crosses the 98% line

#### Scenario: Zero-percent notification at full exhaustion
- **GIVEN** no eligible candidate exists and remaining headroom reaches 0%
- **WHEN** the tick completes
- **THEN** the 0% notification fires, naming the soonest-resetting account and reset time
