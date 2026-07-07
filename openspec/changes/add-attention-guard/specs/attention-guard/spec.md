# attention-guard Delta

## ADDED Requirements

### Requirement: The statusline SHALL render a drift line only on a foreign high-urgency queue head

nexus-statusline SHALL fetch the queue head via an SWR-cached agent read and
render exactly one drift line ("head: <action> — <title> (<source>)") only
when the head verdict is preempt-action or high-confidence AND the head's
request is outside the current session's project context. It SHALL render
nothing on same-project heads, lower-urgency heads, empty queues, or fetch
failures.

#### Scenario: Foreign preempt head surfaces
- **GIVEN** a cc session while the queue head is a high-confidence preempt on a tl request
- **WHEN** the statusline renders
- **THEN** the drift line appears once with action, title, and source

#### Scenario: Healthy alignment is silent
- **GIVEN** the queue head belongs to the current project, or is defer/low-confidence
- **WHEN** the statusline renders
- **THEN** no drift line appears

### Requirement: The statusline SHALL show passive session elapsed time

The statusline SHALL render session elapsed time as plain text with no
thresholds, color escalation, or triggered behavior at any duration.

#### Scenario: Time is visible, nothing fires
- **GIVEN** a session running 2h41m
- **WHEN** the statusline renders
- **THEN** it shows "2h41m" (or equivalent) and no other element changes because of the duration
