# tui-usability-r2 Specification

## Purpose
Round 2 usability polish from re-audit findings.

## ADDED Requirements

### Requirement: close_stream_attach MUST return to previous screen
The method MUST use previous_screen field instead of hardcoded Dashboard.

#### Scenario: Stream entered from Detail
Given user opens stream from Detail screen
When user presses q to close stream
Then they return to Detail screen, not Dashboard

### Requirement: Disconnected sessions MUST show warning on interaction
Pressing attach or detail on a disconnected session MUST show a status message.

#### Scenario: Attach to disconnected session
Given a session is marked disconnected on Dashboard
When user presses 'a' on that session
Then status bar shows "Agent disconnected — session may be unavailable"
And the attach still attempts (non-blocking warning)

### Requirement: Help overlay MUST be accurate for all screens
Help text MUST include Detail-specific help and distinguish Specs list vs detail modes.

#### Scenario: Help on Detail screen
Given user is on Detail screen and presses ?
Then help shows Detail-specific keys: q/Esc:back, a:stream, s:stop

### Requirement: Confirm cancellation MUST show feedback
When a pending confirmation is replaced by a different action, a cancellation message MUST appear.

#### Scenario: Approve then reject
Given user presses Enter (approve pending)
When user presses Backspace
Then status shows "Approval cancelled. Press Bksp again to confirm rejection"
