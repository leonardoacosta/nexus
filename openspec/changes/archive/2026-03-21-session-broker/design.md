# Design: Session Command Broker

## Architecture

```
TUI (any device)              Agent (homelab)
┌──────────────┐   gRPC      ┌─────────────────────────────┐
│ Output panel │◀─stream─────│ stdout parser                │
│              │             │   ↑                          │
│ Input bar    │──SendCmd───▶│ spawn: claude -p             │
│ [> prompt  ] │             │   --resume <session-id>      │
└──────────────┘             │   --output-format stream-json│
                             │   --include-partial-messages │
                             │   --cwd <session.cwd>        │
                             │   --dangerously-skip-perms   │
                             │   "user prompt text"         │
                             └─────────────────────────────┘
```

## Per-Command Lifecycle

```
1. User types prompt in TUI input bar
2. TUI calls SendCommand(session_id, prompt) → server-streaming RPC
3. Agent resolves session from registry (gets cwd, session_id)
4. Agent spawns: claude -p --resume <cc-session-id> --output-format stream-json
     --include-partial-messages --dangerously-skip-permissions "prompt"
5. Agent reads stdout line-by-line, parses stream-json, forwards as CommandOutput messages
6. CC process exits → Agent sends final CommandOutput with done=true
7. TUI marks command complete, re-enables input bar
```

## Proto Additions

```protobuf
message CommandRequest {
  string session_id = 1;     // nexus session ID
  string prompt = 2;         // user prompt text
}

message CommandOutput {
  string session_id = 1;
  oneof content {
    TextChunk text = 2;       // assistant text (partial or complete)
    ToolUseInfo tool_use = 3; // tool call being made
    ToolResult tool_result = 4; // tool output
    CommandError error = 5;   // error from CC or process
    CommandDone done = 6;     // command complete
  }
}

message TextChunk {
  string text = 1;
  bool partial = 2;          // true for streaming tokens, false for complete message
}

message ToolUseInfo {
  string tool_name = 1;
  string input_preview = 2;  // truncated first 200 chars of tool input
}

message ToolResult {
  string tool_name = 1;
  string output_preview = 2; // truncated first 500 chars of output
  bool success = 3;
}

message CommandError {
  string message = 1;
  int32 exit_code = 2;
}

message CommandDone {
  uint64 duration_ms = 1;
  uint32 tool_calls = 2;
}

// Added to service NexusAgent
rpc SendCommand(CommandRequest) returns (stream CommandOutput);
```

## CC stream-json Output Format

CC with `--output-format stream-json --include-partial-messages` emits one JSON object per line:

```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me..."}]}}
{"type":"tool_use","tool":{"name":"Bash","input":{"command":"cargo build"}}}
{"type":"tool_result","tool":{"name":"Bash"},"content":"Build succeeded"}
{"type":"result","result":"Final assistant message","duration_ms":3200}
```

Agent parses each line and maps to CommandOutput proto messages.

## Session ID Mapping

The nexus session ID and the CC session ID may differ:

| Session type | nexus ID | CC session ID | How to resume |
|---|---|---|---|
| Managed | UUID from StartSession | Same UUID (passed via --session-id) | `--resume <uuid>` |
| Ad-hoc | From /tmp/claude-session-$PPID | CC's internal ID | `--resume <cc-session-id>` |

For ad-hoc sessions, the registration hook stores the CC session ID. The agent uses this
for `--resume`. The nexus session entry should store the CC session ID alongside its own ID.

## StartSession Rework

```rust
// OLD: spawn tmux with claude inside
tmux new-session -d -s nx-<id> -- claude [args]

// NEW: create session entry + run bootstrap prompt
let session_id = Uuid::new_v4().to_string();
// 1. Register session in registry
// 2. Run initial command to establish conversation:
claude -p --output-format stream-json \
  --session-id <uuid> \
  --cwd <path> \
  --dangerously-skip-permissions \
  "You are starting a new session in project <project>. Respond with: Ready."
// 3. Session is now resumable via --resume <uuid>
```

## TUI Stream View Layout

```
┌─ INTERACT: oo#aa76 ──────────── q: back ─┐
│ [21:45:02] Text: Looking at the build...  │
│ [21:45:03] Tool: Bash "cargo build"       │
│ [21:45:05] Result: ✓ 0 errors             │
│ [21:45:06] Text: Build passed. The...     │
│                                            │
│                                            │
├────────────────────────────────────────────┤
│ > _                                        │
└────────────────────────────────────────────┘
  0 events · ● connected
```

Input bar states:
- **Idle**: `> _` (cursor blinking, accepts text)
- **Executing**: `⣾ running... (3.2s)` (spinner, input disabled)
- **Error**: `✖ command failed: <reason>` (red, auto-clears after 5s)

## Ad-hoc Session Broker

For ad-hoc sessions, the broker calls `--resume` with the CC session ID from registration.
This means the user can send follow-up prompts to any running CC session from the TUI, even
sessions started in a regular terminal.

Constraint: The CC session must not be actively processing a prompt when SendCommand fires,
or `--resume` will fail. The agent should check session status (Active vs Idle) before spawning.
