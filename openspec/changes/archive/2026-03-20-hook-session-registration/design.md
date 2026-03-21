# Design: Hook-Based Session Registration

## Architecture

```
CC Session Lifecycle:
  SessionStart hook → nexus-register start → gRPC RegisterSession → Registry
  PostToolUse hook  → nexus-register heartbeat → gRPC Heartbeat → Registry
  Stop hook         → nexus-register stop → gRPC UnregisterSession → Registry

Stale Detection (background):
  Every 30s → scan registry → mark >5min as Stale → remove >15min

TUI (unchanged):
  GetSessions gRPC → reads from same registry → displays sessions
```

## Proto Additions

```protobuf
// New messages
message RegisterSessionRequest {
  string session_id = 1;
  uint32 pid = 2;
  string cwd = 3;
  optional string project = 4;
  optional string branch = 5;
  optional string command = 6;
}

message RegisterSessionResponse {
  string session_id = 1;
  bool created = 2;  // false if session already existed (idempotent update)
}

message UnregisterSessionRequest {
  string session_id = 1;
}

message UnregisterSessionResponse {
  bool found = 1;
}

message HeartbeatRequest {
  string session_id = 1;
}

message HeartbeatResponse {
  bool found = 1;
}

// Added to service NexusAgent
rpc RegisterSession(RegisterSessionRequest) returns (RegisterSessionResponse);
rpc UnregisterSession(UnregisterSessionRequest) returns (UnregisterSessionResponse);
rpc Heartbeat(HeartbeatRequest) returns (HeartbeatResponse);
```

## nexus-register CLI Design

Minimal binary in `crates/nexus-register/`. Single `main.rs` with clap subcommands.
Depends on `nexus-core` (for proto types) and `tonic` (gRPC client).

```
nexus-register start --session-id <ID> --pid <PID> --cwd <PATH> [--project <CODE>] [--branch <NAME>]
nexus-register stop --session-id <ID>
nexus-register heartbeat --session-id <ID>
```

**Connection:** `http://localhost:7400` hardcoded (agent always on localhost). 500ms connect
timeout. All errors silently swallowed (exit 0).

**Binary size:** ~3-4MB static. Installed to `~/.local/bin/nexus-register` by deploy hook.

## CC Hook Wiring

```json
{
  "SessionStart": [{
    "matcher": "",
    "hooks": [{
      "type": "command",
      "command": "SID=$(cat /tmp/claude-session-$PPID 2>/dev/null); nexus-register start --session-id \"${SID:-unknown-$PPID}\" --pid $PPID --cwd \"$PWD\" --project \"$(basename \"$CLAUDE_PROJECT_DIR\" 2>/dev/null)\" 2>/dev/null || true",
      "timeout": 2
    }]
  }],
  "Stop": [{
    "matcher": "",
    "hooks": [{
      "type": "command",
      "command": "SID=$(cat /tmp/claude-session-$PPID 2>/dev/null); nexus-register stop --session-id \"${SID:-unknown-$PPID}\" 2>/dev/null || true",
      "timeout": 2
    }]
  }],
  "PostToolUse": [{
    "matcher": "",
    "hooks": [{
      "type": "command",
      "command": "SID=$(cat /tmp/claude-session-$PPID 2>/dev/null); [ -n \"$SID\" ] && nexus-register heartbeat --session-id \"$SID\" 2>/dev/null || true",
      "timeout": 2
    }]
  }]
}
```

**Note:** Session ID is read from `/tmp/claude-session-$PPID`, written by the existing
`session-manager register` hook. The heartbeat hook guards with `[ -n "$SID" ]` to avoid
calling on every tool use when no session ID exists.

## Stale Detection Design

Background tokio task in `main.rs`:

```rust
tokio::spawn(async move {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        interval.tick().await;
        registry.detect_stale(
            Duration::from_secs(300),   // 5min → Stale
            Duration::from_secs(900),   // 15min → Remove
        ).await;
    }
});
```

Registry method `detect_stale`:
1. Iterate all sessions
2. If `idle_seconds() > 900` → remove + emit SessionStopped
3. Else if `idle_seconds() > 300` && status != Stale → mark Stale + emit StatusChanged

## Deploy Hook Update

`deploy/hooks.d/post-merge/02-deploy` must build and install `nexus-register`:

```bash
cargo build --release -p nexus-register
install -m 755 target/release/nexus-register "$BIN_DIR/nexus-register"
```

## TUI Verification

No code changes needed. Verify:
- Ad-hoc sessions (registered via hook) appear in dashboard with `[A]` indicator
- Session status transitions (Active → Stale → removed) render correctly
- Heartbeat-revived sessions (Stale → Active) update in real-time via StreamEvents
