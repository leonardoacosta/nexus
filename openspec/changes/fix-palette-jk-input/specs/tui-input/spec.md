## ADDED Requirements

### Requirement: Palette input accepts all printable characters
The palette text input SHALL pass all printable characters — including 'j' and 'k' — to the query string handler. Navigation within the palette result list SHALL use only arrow keys (`KeyCode::Up` and `KeyCode::Down`).

#### Scenario: Typing 'j' inserts into query
- **WHEN** the palette is open in input mode
- **AND** the user presses the 'j' key
- **THEN** the character 'j' is appended to the palette query string
- **AND** the palette results are refreshed

#### Scenario: Typing 'k' inserts into query
- **WHEN** the palette is open in input mode
- **AND** the user presses the 'k' key
- **THEN** the character 'k' is appended to the palette query string
- **AND** the palette results are refreshed

#### Scenario: Arrow Down navigates palette results
- **WHEN** the palette is open in input mode
- **AND** the user presses the Down arrow key
- **THEN** the selected palette entry moves down by one

#### Scenario: Arrow Up navigates palette results
- **WHEN** the palette is open in input mode
- **AND** the user presses the Up arrow key
- **THEN** the selected palette entry moves up by one
