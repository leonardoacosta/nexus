# nexus-watcher

Standalone Rust binary that watches Claude Code session files for changes and reports session lifecycle events via JSON IPC over stdin/stdout.

## Architecture

The watcher is designed to be spawned as a subprocess by the Bun agent. All communication uses newline-delimited JSON — inbound commands arrive on stdin, outbound events are emitted on stdout. Logs go to stderr via `RUST_LOG`.

```
┌──────────────┐   stdin (JSON)   ┌────────────────┐
│   Bun Agent  │ ───────────────► │  nexus-watcher  │
│              │ ◄─────────────── │                 │
└──────────────┘  stdout (JSON)   └────────────────┘
                                     │ notify (inotify/kqueue)
                                     ▼
                                  ~/.claude/projects/*/sessions.json
```

## IPC Protocol

### Inbound Messages (Agent → Watcher, stdin)

#### `watch` — Start watching paths

```json
{"type":"watch","paths":["/home/user/.claude/projects"]}
```

The watcher recursively monitors each path for `sessions.json` file changes. Multiple `watch` commands can be sent to add paths incrementally.

**Response:** A `watch_ack` message is emitted on stdout confirming the paths.

#### `shutdown` — Graceful shutdown

```json
{"type":"shutdown"}
```

The watcher flushes any pending output and exits with code 0. Closing stdin (EOF) also triggers a graceful shutdown.

### Outbound Messages (Watcher → Agent, stdout)

#### `session_start` — New session detected

```json
{"type":"session_start","session_id":"abc123","project":"co","path":"/home/user/.claude/projects/-home-user-dev-co/sessions.json"}
```

Emitted when a session ID appears in a `sessions.json` file that was not previously tracked. The `project` field is derived from the directory name and may be omitted if it cannot be determined.

#### `session_update` — Existing session modified

```json
{"type":"session_update","session_id":"abc123","timestamp":"2026-04-03T12:00:00.000Z"}
```

Emitted when a `sessions.json` file containing a known session is modified (heartbeat, status change, etc.).

#### `session_end` — Session no longer present

```json
{"type":"session_end","session_id":"abc123"}
```

Emitted when a previously tracked session ID disappears from its `sessions.json` file, or when the file itself is deleted.

#### `watch_ack` — Watch command acknowledged

```json
{"type":"watch_ack","paths":["/home/user/.claude/projects"]}
```

#### `error` — Parse or processing error

```json
{"type":"error","message":"invalid message: expected value at line 1 column 1"}
```

## Building

```bash
cargo build --manifest-path packages/watcher/Cargo.toml
# or release:
cargo build --release --manifest-path packages/watcher/Cargo.toml
```

The binary is output to `packages/watcher/target/{debug,release}/nexus-watcher`.

## Running

```bash
# Start the watcher
./target/debug/nexus-watcher

# Then send commands via stdin:
echo '{"type":"watch","paths":["/home/user/.claude/projects"]}' | ./target/debug/nexus-watcher
```

Set `RUST_LOG` to control log verbosity (logs go to stderr):

```bash
RUST_LOG=debug ./target/debug/nexus-watcher
```

## Testing

```bash
# Unit tests
cargo test --manifest-path packages/watcher/Cargo.toml --lib

# Integration tests (requires built binary)
cargo test --manifest-path packages/watcher/Cargo.toml --test integration

# All tests
cargo test --manifest-path packages/watcher/Cargo.toml
```

## Session Detection

The watcher monitors directories for `sessions.json` files. When a file changes:

1. Parse the JSON (supports both array and object formats)
2. Extract session IDs
3. Diff against previously known sessions
4. Emit `session_start` for new IDs, `session_update` for existing IDs, `session_end` for removed IDs

File events are debounced with a 200ms window to prevent redundant processing from atomic writes.
