# Spec: Input Bar Enhancements

## ADDED Requirements

### Requirement: External Editor Support
The TUI MUST support opening an external editor via Ctrl+E in StreamInput mode. When triggered,
the TUI SHALL leave the alternate screen, write the current input buffer to a temporary file,
spawn `$EDITOR` (falling back to `vi`, then `nano`) with the temp file, wait for the editor
process to exit, read the temp file contents, re-enter the alternate screen, and send the
contents as the prompt if non-empty.

#### Scenario: Ctrl+E opens editor and sends result
- **WHEN** the user presses Ctrl+E in StreamInput mode
- **THEN** the TUI leaves the alternate screen and disables raw mode
- **AND** a temporary file is created with the current input buffer contents
- **AND** `$EDITOR` is spawned with the temp file path as argument
- **AND** after the editor process exits, the temp file is read
- **AND** raw mode is re-enabled and the alternate screen is re-entered
- **AND** if the file contents are non-empty, they are sent as the prompt via SendCommand
- **AND** the temporary file is deleted

#### Scenario: Editor produces empty content
- **WHEN** the user opens the editor via Ctrl+E and saves an empty file or deletes all content
- **THEN** no prompt is sent
- **AND** the input bar returns to its previous state

#### Scenario: EDITOR not set and fallbacks unavailable
- **WHEN** `$EDITOR` is not set and neither `vi` nor `nano` is found on PATH
- **THEN** the status bar shows an error message "no editor found ($EDITOR, vi, nano)"
- **AND** the input bar remains in StreamInput mode unchanged

#### Scenario: Ctrl+E blocked during execution
- **WHEN** a command is currently executing (stream_executing is true)
- **AND** the user presses Ctrl+E
- **THEN** the keypress is ignored (editor is not opened)

### Requirement: Multi-line Input
The input bar MUST support multi-line text entry. Shift+Enter or Ctrl+J SHALL insert a newline
into the input buffer at the cursor position. The input bar SHALL grow dynamically to display
up to 5 visible lines, scrolling the view when content exceeds 5 lines. Enter (without Shift)
SHALL send the complete multi-line buffer as the prompt.

#### Scenario: Insert newline with Shift+Enter
- **WHEN** the user presses Shift+Enter in StreamInput mode
- **THEN** a newline character is inserted into the input buffer
- **AND** the input bar height increases by one row (up to the 5-line maximum)

#### Scenario: Insert newline with Ctrl+J
- **WHEN** the user presses Ctrl+J in StreamInput mode
- **THEN** a newline character is inserted into the input buffer (same behavior as Shift+Enter)

#### Scenario: Input bar grows to 5 lines then scrolls
- **WHEN** the input buffer contains more than 5 lines
- **THEN** the input bar remains at 5 lines height
- **AND** the visible portion scrolls to keep the cursor line visible

#### Scenario: Enter sends multi-line content
- **WHEN** the user presses Enter (without Shift) and the input buffer contains multiple lines
- **THEN** the complete multi-line buffer is sent as a single prompt via SendCommand
- **AND** the input buffer is cleared

#### Scenario: Multi-line input blocked during execution
- **WHEN** a command is currently executing (stream_executing is true)
- **AND** the user presses Shift+Enter or Ctrl+J
- **THEN** the keypress is ignored

### Requirement: Input History
The input bar MUST maintain a history of previously sent prompts. Up and Down arrow keys SHALL
cycle through history entries when the input buffer is empty. History SHALL be stored per-session
in a Vec with a maximum capacity of 50 entries.

#### Scenario: Navigate history with Up arrow
- **WHEN** the input buffer is empty and the user presses Up
- **THEN** the most recently sent prompt is loaded into the input buffer
- **AND** pressing Up again loads the next older prompt

#### Scenario: Navigate history with Down arrow
- **WHEN** the user has navigated into history and presses Down
- **THEN** the next more recent prompt is loaded into the input buffer
- **AND** pressing Down past the most recent entry clears the input buffer

#### Scenario: History is not navigated when input is non-empty
- **WHEN** the input buffer contains text and the user presses Up or Down
- **THEN** the keypress is ignored (no history navigation)

#### Scenario: History capacity limit
- **WHEN** 50 prompts have been sent and a 51st prompt is sent
- **THEN** the oldest prompt is removed from history
- **AND** the new prompt is added at the end

#### Scenario: Duplicate prompts in history
- **WHEN** the user sends a prompt that is identical to the most recent history entry
- **THEN** no duplicate is added to history (the existing entry remains)

#### Scenario: History not available during execution
- **WHEN** a command is currently executing
- **AND** the user presses Up or Down
- **THEN** the keypress is ignored

### Requirement: Placeholder Text
The input bar MUST display dim placeholder text when the input buffer is empty and no command
is executing. The placeholder text SHALL be "type a prompt, Ctrl+E for editor".

#### Scenario: Placeholder shown on empty input
- **WHEN** the input buffer is empty and no command is executing
- **THEN** the input bar displays "type a prompt, Ctrl+E for editor" in dim/muted color (TEXT_DIM)

#### Scenario: Placeholder disappears on typing
- **WHEN** the user types any character
- **THEN** the placeholder text is replaced by the typed character

#### Scenario: Placeholder not shown during execution
- **WHEN** a command is executing (spinner is shown)
- **THEN** the placeholder is not displayed (the spinner takes precedence)
