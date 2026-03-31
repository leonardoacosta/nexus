## ADDED Requirements

### Requirement: Unified Prompt Submission Method
`App` SHALL expose a `submit_prompt` method that encapsulates the full prompt submission sequence: clear input buffer, set `stream_executing` to true, record `stream_exec_start`, push prompt to history, push user header line, push each prompt line as `UserPrompt`, push a blank separator, reset `assistant_header_emitted` to false, and send `RpcCommand::SendCommand` with the session ID and prompt. Both the Enter key handler in `keys.rs` and the external editor submit in `ui_helpers.rs` SHALL call `submit_prompt` instead of inlining this logic.

#### Scenario: Enter key submission uses submit_prompt
- **WHEN** the user presses Enter with a non-empty input buffer in stream mode
- **THEN** `keys.rs` calls `app.submit_prompt()` which performs all prompt submission steps in a single method call

#### Scenario: External editor submission uses submit_prompt
- **WHEN** the user submits a prompt via the external editor
- **THEN** `ui_helpers.rs` calls `app.submit_prompt()` which performs the same prompt submission steps as the Enter key path

#### Scenario: Empty prompt is rejected
- **WHEN** the prompt string is empty
- **THEN** `submit_prompt` returns early without modifying state or sending a command
