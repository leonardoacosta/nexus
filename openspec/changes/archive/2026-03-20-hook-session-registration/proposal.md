# Proposal: Hook-Based Session Registration

## Change ID
`hook-session-registration`

## Summary
Replace file-based session discovery (sessions.json watcher) with direct gRPC registration from
Claude Code hooks via a compiled Rust CLI binary (`nexus-register`), including per-session
heartbeat and stale detection.

## Context
- Extends: `proto/nexus.proto`, `crates/nexus-agent/src/{grpc.rs, registry.rs, main.rs}`
- Removes: `crates/nexus-agent/src/watcher.rs`
- New crate: `crates/nexus-register/` (lightweight gRPC client CLI)
- Modifies: `~/.claude/settings.json` (global CC hooks)
- Related: PRD §7.5 Option B (target architecture), `agent-grpc-server` (completed)

## Motivation
The MVP session discovery watches `sessions.json`, which requires `claude-daemon` to be running
as the file producer. This creates an unnecessary dependency on a separate daemon that is being
deprecated. Option B from the PRD eliminates this dependency by having CC hooks register sessions
directly with nexus-agent via gRPC, making the agent self-sufficient.

## Requirements

### Req-1: Session Registration RPCs
Add `RegisterSession` and `UnregisterSession` RPCs to the `NexusAgent` gRPC service. These handle
ad-hoc session lifecycle without spawning tmux (unlike `StartSession` which creates managed sessions).

### Req-2: Heartbeat RPC
Add a `Heartbeat` RPC that updates a session's `last_heartbeat` timestamp. Called by CC hooks on
tool-use events to indicate session activity.

### Req-3: Stale Session Detection
Agent runs a background task (every 30s) that marks sessions as `Stale` when their
`last_heartbeat` exceeds 5 minutes, and removes sessions whose heartbeat exceeds 15 minutes
(assumed dead without Stop hook firing).

### Req-4: nexus-register CLI Binary
A new crate (`crates/nexus-register/`) providing a lightweight CLI that CC hooks invoke. Commands:
`start`, `stop`, `heartbeat`. Connects to `localhost:7400` via gRPC. Fails silently on connection
errors (must never block CC).

### Req-5: CC Hook Integration
Add hooks to `~/.claude/settings.json`:
- `SessionStart`: calls `nexus-register start` with session metadata
- `Stop`: calls `nexus-register stop` to unregister
- `PostToolUse`: calls `nexus-register heartbeat` to update activity

### Req-6: Remove File Watcher
Delete `watcher.rs` and remove the `start_session_watcher` call from `main.rs`. Sessions are
exclusively populated via gRPC registration. The `notify` crate dependency can be removed.

### Req-7: TUI Compatibility
No TUI changes required — the TUI already reads sessions via `GetSessions` gRPC. This spec
only changes how sessions enter the registry. Verify the TUI correctly displays ad-hoc sessions
registered via the new RPCs (session_type = AD_HOC, no tmux_session).

## Scope
- **IN**: Proto changes, agent RPCs, registry methods, stale detection, nexus-register CLI,
  CC hook wiring, watcher removal, deploy hook update, TUI verification
- **OUT**: Managed session changes, TUI UI changes, iMessage integration, HTTP registration
  endpoints

## Impact
| Area | Change |
|------|--------|
| `proto/nexus.proto` | Add RegisterSession, UnregisterSession, Heartbeat RPCs + messages |
| `crates/nexus-agent/src/grpc.rs` | Implement 3 new RPCs |
| `crates/nexus-agent/src/registry.rs` | Add `register_adhoc`, `unregister`, stale pruning |
| `crates/nexus-agent/src/main.rs` | Remove watcher, add stale detection background task |
| `crates/nexus-agent/src/watcher.rs` | Delete entirely |
| `crates/nexus-register/` | New crate — CLI binary |
| `Cargo.toml` (workspace) | Add nexus-register member |
| `~/.claude/settings.json` | Add 3 hooks (SessionStart, Stop, PostToolUse) |
| `deploy/hooks.d/post-merge/02-deploy` | Build nexus-register alongside agent + TUI |

## Risks
| Risk | Mitigation |
|------|-----------|
| nexus-agent not running when CC starts | nexus-register fails silently (`|| true`), session just won't appear in TUI |
| Stop hook doesn't fire (kill -9, crash) | Stale detection auto-removes after 15min |
| Hook adds latency to CC operations | nexus-register connects + sends in <50ms; 2s timeout in hook config |
| Race: heartbeat arrives before registration | Registry ignores heartbeats for unknown session IDs (no-op) |
| Cargo build time increase | nexus-register is minimal (tonic client only, ~2s incremental) |
