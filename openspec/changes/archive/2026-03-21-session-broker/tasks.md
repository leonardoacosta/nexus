# Implementation Tasks

<!-- beads:epic:nexus-t72 -->

## DB Batch

- [x] [1.1] [P-1] Add CommandRequest, CommandOutput, TextChunk, ToolUseInfo, ToolResult, CommandError, CommandDone messages to proto/nexus.proto [owner:api-engineer] [beads:nexus-afz]
- [x] [1.2] [P-1] Add SendCommand server-streaming RPC to NexusAgent service in proto/nexus.proto [owner:api-engineer] [beads:nexus-99j]
- [x] [1.3] [P-1] Add cc_session_id field to Session message in proto/nexus.proto for ad-hoc resume support [owner:api-engineer] [beads:nexus-9ei]

## API Batch

- [x] [2.1] [P-1] Add cc_session_id: Option<String> field to nexus_core::session::Session struct [owner:api-engineer] [beads:nexus-5ca]
- [x] [2.2] [P-1] Update RegisterSession RPC to store cc_session_id (same as session_id for ad-hoc) [owner:api-engineer] [beads:nexus-bdl]
- [x] [2.3] [P-1] Implement stream-json output parser module in nexus-agent (parse CC JSON lines into CommandOutput proto messages) [owner:api-engineer] [beads:nexus-am8]
- [x] [2.4] [P-1] Implement SendCommand RPC in grpc.rs — spawn claude process, pipe stdout, stream parsed output [owner:api-engineer] [beads:nexus-uxi]
- [x] [2.5] [P-2] Rework StartSession RPC — remove tmux spawn, create session entry + run bootstrap prompt [owner:api-engineer] [beads:nexus-9v6]
- [x] [2.6] [P-2] Remove tmux-related helper functions (get_tmux_session_pid) from grpc.rs [owner:api-engineer] [beads:nexus-6z9]

## UI Batch

- [x] [3.1] [P-1] Add send_command method to TUI NexusClient that calls SendCommand RPC and returns a streaming receiver [owner:api-engineer] [beads:nexus-5ln]
- [x] [3.2] [P-1] Add InputMode::StreamInput variant and input buffer fields to App state [owner:api-engineer] [beads:nexus-0ah]
- [x] [3.3] [P-1] Implement input bar widget in screens/stream.rs — text input, Enter to send, spinner during execution [owner:api-engineer] [beads:nexus-az5]
- [x] [3.4] [P-1] Wire input bar keypress handling in main.rs — text entry, Enter dispatches SendCommand, Esc cancels [owner:api-engineer] [beads:nexus-f6l]
- [x] [3.5] [P-1] Render CommandOutput messages (TextChunk, ToolUseInfo, ToolResult, CommandDone) in the stream log panel [owner:api-engineer] [beads:nexus-9ln]
- [x] [3.6] [P-2] Delete attach.rs and remove SSH+tmux attach keybinding (A) from main.rs [owner:api-engineer] [beads:nexus-99o]
- [x] [3.7] [P-2] Change stream attach to auto-enter input mode when pressing 'a' (interactive by default) [owner:api-engineer] [beads:nexus-jhu]
- [x] [3.8] [P-2] Show "use 'a' for interactive stream" in status bar when user presses 'A' [owner:api-engineer] [beads:nexus-wp9]

## E2E Batch

- [x] [4.1] Verify: SendCommand round-trip — send prompt to managed session, confirm streamed output [owner:e2e-engineer] [beads:nexus-06o]
- [x] [4.2] Verify: SendCommand to ad-hoc session — resume works with CC session ID [owner:e2e-engineer] [beads:nexus-j04]
- [x] [4.3] Verify: TUI input bar renders, accepts text, sends on Enter, shows spinner during execution [owner:e2e-engineer] [beads:nexus-53r]
- [x] [4.4] Verify: StartSession creates resumable session without tmux [owner:e2e-engineer] [beads:nexus-8vb]
- [x] [4.5] Verify: 'A' key shows status message instead of spawning SSH [owner:e2e-engineer] [beads:nexus-n4y]
