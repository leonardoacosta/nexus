# Proposal: Session Command Broker

## Change ID
`session-broker`

## Summary
Replace tmux-based managed sessions with a gRPC command broker that lets the TUI send prompts
to any CC session and receive streamed output. The agent spawns `claude -p --resume <session-id>
--output-format stream-json` per command, piping output back via gRPC streaming.

## Context
- Extends: `proto/nexus.proto`, `crates/nexus-agent/src/grpc.rs`, `crates/nexus-tui/src/stream.rs`
- Modifies: `crates/nexus-tui/src/screens/stream.rs` (add input bar)
- Removes: `crates/nexus-tui/src/attach.rs` (SSH+tmux attach), tmux spawn in StartSession
- Related: `hook-session-registration` (completed), `stream-events-rpc` (completed)

## Motivation
The current managed session model spawns CC inside tmux and relies on SSH+tmux attach for
interaction. This breaks on iOS terminals (Terminus) due to key mapping issues and requires
nested tmux handling. CC already has `--print --output-format stream-json --resume <session-id>`
which provides a structured streaming API. The TUI should act as a command broker — user types
a prompt, agent executes it against the CC session, output streams back via gRPC. No SSH, no
tmux, works from any client including iOS.

## Requirements

### Req-1: SendCommand gRPC RPC
A new server-streaming RPC that accepts a user prompt and session ID, spawns
`claude -p --resume <session-id> --output-format stream-json --include-partial-messages` with
the prompt as positional arg, and streams parsed output events back to the caller. Works for
both managed and ad-hoc sessions.

### Req-2: Agent Command Execution
The agent spawns the CC process per command (not a long-running subprocess). Each invocation
uses `--resume` to continue the conversation. The agent must:
- Inherit the correct `--cwd` from the session's registered working directory
- Pass `--dangerously-skip-permissions` (matching existing session flags)
- Parse stream-json output lines and forward as gRPC messages
- Handle process exit (success/error) and signal completion to the TUI

### Req-3: TUI Input Bar
The stream attach view gains a bottom input bar. User types a prompt, presses Enter to send.
The TUI calls `SendCommand` and renders streamed output chunks in the log panel above. While
a command is executing, the input bar shows a spinner/status. The input bar is available for
all session types (managed and ad-hoc).

### Req-4: Replace tmux-based StartSession
`StartSession` RPC no longer spawns tmux. Instead it creates a session entry (like
`RegisterSession`) and runs an initial `claude -p --output-format stream-json --session-id <uuid>`
with a bootstrap prompt to establish the conversation. The session is then available for
`SendCommand` via `--resume`.

### Req-5: Remove SSH+tmux Attach
Remove `attach.rs` and the `A` keybinding for full attach. All interaction goes through the
broker. The `a` key now opens the interactive stream view (with input bar).

## Scope
- **IN**: SendCommand RPC, agent process spawning, TUI input bar, StartSession rework,
  attach.rs removal, stream view refactor
- **OUT**: Permission prompt proxying (sessions run with `--dangerously-skip-permissions`),
  file upload/download, interactive tool approval, web frontend

## Impact
| Area | Change |
|------|--------|
| `proto/nexus.proto` | Add SendCommand RPC, CommandRequest, CommandOutput messages |
| `crates/nexus-agent/src/grpc.rs` | Implement SendCommand — process spawn + output streaming |
| `crates/nexus-agent/src/grpc.rs` | Rework StartSession — no tmux, initial bootstrap |
| `crates/nexus-tui/src/stream.rs` | Add SendCommand client call, wire to input bar |
| `crates/nexus-tui/src/screens/stream.rs` | Add input bar widget, handle text input |
| `crates/nexus-tui/src/attach.rs` | Delete entirely |
| `crates/nexus-tui/src/main.rs` | Remove attach keybinding, update stream flow |
| `crates/nexus-tui/src/client.rs` | Add send_command method |

## Risks
| Risk | Mitigation |
|------|-----------|
| `--resume` with `--print` may not support all CC features | Test with slash commands, multi-turn. Worst case: some features unavailable via broker |
| Each command spawns a new process (~1-2s startup) | Acceptable for interactive use; could pool processes later |
| No permission prompts in `--print` mode | Already using `--dangerously-skip-permissions` |
| Large output may overwhelm gRPC stream | Stream-json output is line-by-line; backpressure via mpsc channel |
| Ad-hoc session --resume needs correct session ID | Hook registration already captures CC session IDs |
