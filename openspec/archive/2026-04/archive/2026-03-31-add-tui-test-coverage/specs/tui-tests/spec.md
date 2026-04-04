# Capability: TUI Test Coverage

Unit and snapshot test coverage for the nexus TUI client.

## ADDED Requirements

### Requirement: State transition verification

The TUI app SHALL have tests verifying screen navigation and key event handling.

#### Scenario: Tab cycles screens
- **WHEN** the user presses Tab on the dashboard screen
- **THEN** the app transitions to the next screen in order

#### Scenario: Quit exits cleanly
- **WHEN** the user presses 'q' on any screen
- **THEN** the app sets the quit flag without panic

#### Scenario: Detail entry and exit
- **WHEN** the user presses Enter on a selected session, then Esc
- **THEN** the app enters detail view, then returns to the previous screen

### Requirement: Client aggregation verification

The TUI client SHALL have tests verifying multi-agent session aggregation.

#### Scenario: Sessions from multiple agents merge
- **WHEN** the client receives sessions from agents A and B
- **THEN** the merged session list contains sessions from both agents

#### Scenario: Duplicate sessions dedup by ID
- **WHEN** two agents report the same session ID
- **THEN** only one copy appears in the merged list

#### Scenario: Connection failure returns empty
- **WHEN** an agent is unreachable
- **THEN** the client returns an empty session list for that agent without panicking

### Requirement: Screen rendering safety

Each screen SHALL render without panic on empty, partial, and full data inputs.

#### Scenario: Dashboard with zero sessions
- **WHEN** the dashboard renders with an empty session list
- **THEN** it produces valid terminal output without panic

#### Scenario: Detail with missing optional fields
- **WHEN** the detail screen renders a session with all Optional fields as None
- **THEN** it produces valid terminal output showing placeholder values
