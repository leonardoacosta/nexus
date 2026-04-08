# tui-input Specification

## Purpose
TBD - created by archiving change fix-palette-jk-input. Update Purpose after archive.
## Requirements
### Requirement: Palette input accepts all printable characters
The palette text input SHALL pass all printable characters — including 'j' and 'k' — to the
query string handler. Navigation within the palette result list SHALL use only arrow keys
(`KeyCode::Up` and `KeyCode::Down`). The palette query matching SHALL use a case-insensitive
fuzzy (prefix-contains) algorithm: a candidate matches when the lowercased candidate string
contains the lowercased query as a substring. Results SHALL be ranked by match position
(earlier match = higher rank). Matched substrings SHALL be highlighted in the rendered result
rows using a distinct span style.

#### Scenario: Typing 'j' inserts into query
- **WHEN** the palette is open in input mode
- **AND** the user presses the 'j' key
- **THEN** the character 'j' is appended to the palette query string
- **AND** the palette results are refreshed using fuzzy matching

#### Scenario: Typing 'k' inserts into query
- **WHEN** the palette is open in input mode
- **AND** the user presses the 'k' key
- **THEN** the character 'k' is appended to the palette query string
- **AND** the palette results are refreshed using fuzzy matching

#### Scenario: Arrow Down navigates palette results
- **WHEN** the palette is open in input mode
- **AND** the user presses the Down arrow key
- **THEN** the selected palette entry moves down by one

#### Scenario: Arrow Up navigates palette results
- **WHEN** the palette is open in input mode
- **AND** the user presses the Up arrow key
- **THEN** the selected palette entry moves up by one

#### Scenario: Fuzzy match — partial query matches session name
- **WHEN** the query is "prod"
- **AND** a session name is "production-deploy"
- **THEN** the session appears in the palette results
- **AND** the substring "prod" is highlighted in the rendered row

#### Scenario: Fuzzy match — case insensitive
- **WHEN** the query is "PROD"
- **AND** a session name is "production-deploy"
- **THEN** the session appears in the palette results

#### Scenario: Fuzzy match — earlier match ranks higher
- **WHEN** the query is "nx"
- **AND** results include "nx-agent" (match at position 0) and "app-nx-tui" (match at position 4)
- **THEN** "nx-agent" ranks above "app-nx-tui" in the result list

### Requirement: Multi-select for bulk session operations
The session list SHALL support multi-select mode. Pressing `Space` on a focused session row
SHALL toggle its selection state. Selected rows SHALL render a filled checkbox indicator in
the first column. When one or more sessions are selected, the bulk-kill action (`d` key with
two-step confirmation) SHALL operate on all selected sessions. When no sessions are selected,
`d` SHALL operate on the focused session only (existing behaviour). Selection SHALL be cleared
when the user navigates away from the session list screen.

#### Scenario: Space toggles selection on focused row
- **WHEN** the user presses `Space` on an unselected session row
- **THEN** the row is marked selected and a filled checkbox is rendered in the first column

#### Scenario: Space deselects a selected row
- **WHEN** the user presses `Space` on an already-selected session row
- **THEN** the row is marked unselected and the checkbox is removed

#### Scenario: Bulk kill operates on selected sessions
- **WHEN** two sessions are selected
- **AND** the user presses `d` and confirms
- **THEN** kill requests are sent for both selected sessions

#### Scenario: Kill without selection operates on focused session
- **WHEN** no sessions are selected
- **AND** the user presses `d` on a focused row and confirms
- **THEN** only the focused session receives a kill request

#### Scenario: Selection cleared on screen transition
- **WHEN** the user navigates from the session list to the Detail screen
- **THEN** `selected_sessions` is cleared

