# tui-usability-r3 Specification

## Purpose
TBD - created by archiving change fix-tui-usability-r3. Update Purpose after archive.
## Requirements
### Requirement: Empty Dashboard MUST orient new users
The empty state MUST describe what Nexus does and how to get started.

#### Scenario: First launch with no sessions
Given no agents have sessions
When the Dashboard renders
Then it shows a welcome message with Nexus description and key hints including ?

### Requirement: ? help MUST be hinted in all title bars
Every screen title bar MUST include "?: help" in its hint text.

#### Scenario: Dashboard title bar
Given the user is on Dashboard
When they read the title bar
Then "?: help" is visible alongside other hints

### Requirement: Config failure MUST not crash
Missing or malformed agents.toml MUST result in a warning and empty agent list, not a crash.

#### Scenario: Missing config file
Given ~/.config/nexus/agents.toml does not exist
When the TUI starts
Then it shows a warning message with the expected config path and continues with no agents

### Requirement: Approve/reject MUST be disabled on finalized specs
Specs with status approved, applied, archived, or rejected MUST not allow approve/reject actions.

#### Scenario: Already approved spec
Given a spec has status "approved"
When user presses Enter in detail view
Then status bar shows "Spec already approved" and no HTTP request is sent

