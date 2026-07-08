# decide-flow Delta

## ADDED Requirements

### Requirement: An iOS widget SHALL render the queue head and nothing else

A WidgetKit extension SHALL render, in small home and lock-screen accessory
families only, the queue-head item's verdict action and truncated title. It
SHALL render a "clear" state on an empty queue and SHALL retain the last
rendered entry on fetch failure. It SHALL NOT render counts, badges, backlog
totals, override rates, or lists in any state. Tapping SHALL open the
nexus-ios app.

#### Scenario: Head renders as one action
- **GIVEN** the ranked queue's head is a delegate-verdict item
- **WHEN** the widget timeline refreshes
- **THEN** the widget shows the action and truncated title with no numeric aggregate anywhere

#### Scenario: Empty queue renders clear, not zero
- **GIVEN** no open verdict-bearing requests
- **WHEN** the widget refreshes
- **THEN** it renders the "clear" state and no count

#### Scenario: Fetch failure degrades silently
- **GIVEN** the agent is unreachable
- **WHEN** the timeline refresh runs
- **THEN** the prior entry remains and no error state or staleness alarm renders
