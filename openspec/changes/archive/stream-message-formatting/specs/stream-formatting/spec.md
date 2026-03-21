## ADDED Requirements

### Requirement: Role-Based Line Coloring

The TUI stream view SHALL apply distinct colors to each message role in the log view:

- User prompt lines (`── you ──` and prompt text): green (`PRIMARY`)
- Assistant text: white/light gray (`TEXT`)
- Tool call headers: bold cyan (`SECONDARY`) with filled circle prefix
- Tool input previews: dim (`TEXT_DIM`)
- Tool results (success): dim (`TEXT_DIM`)
- Tool results (failure): red (`ERROR`)
- Error messages: red (`ERROR`)
- Done summary lines: dim green (`PRIMARY_DIM`)

Each line in the stream buffer SHALL carry style metadata so the renderer can apply the
correct color without parsing line content.

#### Scenario: User prompt displayed in green

- **WHEN** the user submits a command via the input bar
- **THEN** the `── you ──` separator and the echoed prompt text are rendered in green (`PRIMARY`)
- **AND** they are visually distinct from assistant output

#### Scenario: Assistant text displayed in white

- **WHEN** the agent streams text chunks (partial or full)
- **THEN** each line is rendered in the default text color (`TEXT`)

#### Scenario: Error displayed in red

- **WHEN** the agent streams a `CommandError` event
- **THEN** the error line is rendered in red (`ERROR`)
- **AND** the line includes exit code and message

#### Scenario: Done line displayed in dim green

- **WHEN** the agent streams a `CommandDone` event
- **THEN** the done summary line is rendered in dim green (`PRIMARY_DIM`)

### Requirement: Inline Tool Call Blocks

The TUI stream view SHALL render tool calls as structured inline blocks instead of flat
single-line text.

A tool call SHALL be rendered as:
```
⏺ {tool_name}
  $ {input_preview}
  ✓ {tool_name}: {output_preview}
```

- The header line (`⏺ {tool_name}`) SHALL use bold cyan (`SECONDARY`)
- The input preview line SHALL be indented two spaces and use dim text (`TEXT_DIM`)
- The result line SHALL use `✓` for success and `✗` for failure
- Failed tool results SHALL use red (`ERROR`) instead of dim

#### Scenario: Successful tool call rendered as block

- **WHEN** the agent streams a `ToolUseInfo` event for tool "Bash" with input "cargo build"
- **AND** a subsequent `ToolResult` event with `success = true`
- **THEN** the log shows:
  - Line 1: `⏺ Bash` in bold cyan
  - Line 2: `  $ cargo build` in dim
  - Line 3: `  ✓ Bash: {output_preview}` in dim

#### Scenario: Failed tool call rendered with error styling

- **WHEN** the agent streams a `ToolUseInfo` event followed by a `ToolResult` with `success = false`
- **THEN** the result line uses `✗` prefix and red color
- **AND** the tool header and input preview retain their normal styling

### Requirement: Spinner with Elapsed Time

The executing spinner in the input bar SHALL display elapsed seconds since the command
began executing.

The format SHALL be: `{spinner_char} executing... ({elapsed}s)` where `{elapsed}` is
seconds with one decimal place (e.g., `3.2s`).

The elapsed time SHALL be computed by storing `Instant::now()` when execution begins and
computing the difference on each render tick.

#### Scenario: Spinner shows elapsed time during execution

- **WHEN** a command is executing (stream_executing is true)
- **AND** the TUI renders the input bar
- **THEN** the spinner line shows the current elapsed time in seconds (e.g., `⠋ executing... (1.5s)`)
- **AND** the elapsed time updates on each render tick

#### Scenario: Elapsed time resets between commands

- **WHEN** a command finishes (CommandStreamDone received)
- **AND** the user submits a new command
- **THEN** the elapsed timer starts from zero for the new command
