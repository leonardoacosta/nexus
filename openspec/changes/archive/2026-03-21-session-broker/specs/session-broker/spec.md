# Spec: Session Command Broker

## ADDED Requirements

### Requirement: SendCommand RPC
The agent MUST expose a server-streaming `SendCommand` RPC that accepts a session ID and prompt,
spawns a CC process with `--resume --output-format stream-json`, and streams parsed output back.

#### Scenario: Send command to managed session
**Given** a managed session with ID "abc123" exists in the registry
**When** a `SendCommand` RPC is received with session_id "abc123" and prompt "cargo build"
**Then** the agent spawns `claude -p --resume abc123 --output-format stream-json --include-partial-messages --dangerously-skip-permissions "cargo build"`
**And** stdout lines are parsed and forwarded as `CommandOutput` messages
**And** a `CommandDone` message is sent when the process exits

#### Scenario: Send command to ad-hoc session
**Given** an ad-hoc session with nexus ID "adhoc-123" and CC session ID "cc-uuid-456" exists
**When** a `SendCommand` RPC is received with session_id "adhoc-123" and prompt "check status"
**Then** the agent uses the CC session ID "cc-uuid-456" for `--resume`
**And** output streams back identically to managed sessions

#### Scenario: Session not found
**Given** no session with ID "unknown-999" exists in the registry
**When** a `SendCommand` RPC is received with session_id "unknown-999"
**Then** the RPC returns a `CommandOutput` with `CommandError` and message "session not found"

#### Scenario: CC process fails to start
**Given** a session exists but `claude` is not on PATH
**When** a `SendCommand` RPC is received
**Then** the RPC returns a `CommandOutput` with `CommandError` and the spawn error message

### Requirement: TUI Input Bar
The stream view MUST include a bottom input bar for sending prompts to the session.

#### Scenario: User sends a prompt
**Given** the TUI is in stream view for session "abc123"
**When** the user types "fix the bug" and presses Enter
**Then** the TUI calls `SendCommand` with session_id "abc123" and prompt "fix the bug"
**And** the input bar shows a spinner while the command executes
**And** output chunks appear in the log panel above

#### Scenario: Command completes
**Given** a command is executing and streaming output
**When** the `CommandDone` message is received
**Then** the input bar returns to idle state (accepts new input)
**And** the duration is shown briefly in the status bar

#### Scenario: Input during execution
**Given** a command is currently executing
**When** the user tries to type in the input bar
**Then** input is blocked (bar shows spinner, keystrokes ignored)

### Requirement: StartSession Without tmux
`StartSession` RPC MUST create a session entry and run a bootstrap prompt via
`claude -p --session-id <uuid>` to establish the conversation. No tmux session is spawned.

#### Scenario: Start a new managed session
**Given** the agent receives a `StartSession` RPC with project "oo" and cwd "~/dev/oo"
**When** the session is created
**Then** a session entry is registered with the generated UUID
**And** a bootstrap command runs: `claude -p --session-id <uuid> --cwd ~/dev/oo "Ready."`
**And** the session is available for `SendCommand` via `--resume <uuid>`

#### Scenario: Bootstrap fails
**Given** the `claude` binary is not available
**When** `StartSession` is called
**Then** the RPC returns an error with the failure reason
**And** no session entry is created

### Requirement: CC Session ID Storage
The session registry MUST store the CC session ID for ad-hoc sessions separately from the
nexus session ID, enabling `--resume` with the correct identifier.

#### Scenario: Ad-hoc session stores CC session ID
**Given** a CC session registers via `RegisterSession` with session_id "cc-uuid-456"
**When** the session is stored in the registry
**Then** the CC session ID "cc-uuid-456" is preserved and usable for `--resume`

### Requirement: Stream-JSON Output Parsing
The agent MUST parse CC's stream-json output format and map each line to the appropriate
`CommandOutput` message type.

#### Scenario: Parse text output
**Given** CC emits `{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}`
**When** the agent parses this line
**Then** a `CommandOutput` with `TextChunk { text: "Hello", partial: false }` is sent

#### Scenario: Parse tool use
**Given** CC emits `{"type":"tool_use","tool":{"name":"Bash","input":{"command":"ls"}}}`
**When** the agent parses this line
**Then** a `CommandOutput` with `ToolUseInfo { tool_name: "Bash", input_preview: "ls" }` is sent

#### Scenario: Parse final result
**Given** CC emits `{"type":"result","result":"Done","duration_ms":3200}`
**When** the agent parses this line
**Then** a `CommandOutput` with `CommandDone { duration_ms: 3200 }` is sent

## REMOVED Requirements

### Requirement: SSH+tmux Full Attach
The TUI MUST NOT provide SSH+tmux based full attach. The `A` keybinding and `attach.rs`
module are removed. All session interaction uses the command broker.

#### Scenario: Attempt full attach
**Given** the user presses `A` on a session in the dashboard
**When** the keypress is processed
**Then** no SSH process is spawned
**And** the status bar shows "use 'a' for interactive stream"
