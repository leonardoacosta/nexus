## ADDED Requirements

### Requirement: Command Progress Events
The `SendCommand` RPC stream SHALL emit `ProgressUpdate` messages during command execution
to enable relay consumers to show incremental progress.

#### Scenario: Tool use emits progress
- **WHEN** a Claude CLI subprocess begins a tool invocation during command execution
- **THEN** a `ProgressUpdate` is emitted with `phase` set to the tool name
- **AND** `summary` contains a brief description of the tool action

#### Scenario: Command completion includes summary
- **WHEN** a command finishes execution
- **THEN** a `CommandDone` message is emitted with `duration_ms` and `tool_calls` populated
- **AND** the consumer can construct a final summary from these fields

#### Scenario: Existing consumers unaffected
- **WHEN** a consumer only handles `TextChunk`, `ToolUseInfo`, `ToolResult`, `CommandError`, `CommandDone`
- **AND** the stream includes `ProgressUpdate` messages
- **THEN** the consumer ignores unknown variants without error
