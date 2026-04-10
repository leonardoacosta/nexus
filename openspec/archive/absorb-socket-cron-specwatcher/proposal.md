# Proposal: Absorb Unix Socket, Cron, and Spec Watcher into Bun Agent

## Change ID
`absorb-socket-cron-specwatcher`

## Summary
Port three Rust-only capabilities (Unix domain socket server, cron service, spec watcher) into the Bun agent, making it self-sufficient for hook event ingestion, scheduled maintenance, and spec lifecycle tracking.

## Context
- Extends: `apps/agent/src/server.ts`, `apps/agent/src/session-manager.ts`
- Related: `crates/nexus-agent/src/socket.rs`, `crates/nexus-agent/src/cron.rs`, `crates/nexus-agent/src/services/spec_watcher.rs`

## Motivation
The Rust agent currently owns three capabilities that the Bun agent needs to function independently: (1) the Unix socket at `/tmp/nexus-agent.sock` that receives CC hook events (session start/stop, heartbeat, notifications, telemetry), (2) a cron service with two scheduled jobs (daily maintenance, weekly drift check), and (3) a spec watcher that polls `openspec` for change detection and fires TTS. Porting these to Bun is the first step toward retiring the Rust agent entirely. All three are low-complexity — the socket is NDJSON over a Unix stream (Bun native), the cron is two timer-based jobs (~150 LOC), and the spec watcher shells out to `openspec list --json` (~200 LOC).

## Requirements

### Req-1: Unix socket server
Bun agent listens on `/tmp/nexus-agent.sock` using `Bun.listen({ unix })`. Accepts newline-delimited JSON events matching the existing protocol: `SessionStart`, `SessionStop`, `SessionHeartbeat`, `Notification`, `Answer`, `AgentSpawn`, `AgentComplete`, `Telemetry`, `SessionSummary`, `DeployStatus`. Also handles command types: `ModeQuery`, `ModeSet`, `ModeCycle`, `History`, `TypeSet`, `TypeClear`, `NotificationRules`, `NotificationSet`. Writers (CC hooks, nova, nexus CLI) must work without modification.

### Req-2: Cron service
Two scheduled jobs: (1) `maintain` — daily at 00:17, prunes temp files, old JSONL logs, debug logs, paste-cache, session dirs. (2) `drift` — weekly Sunday at 09:00, validates settings.json, checks orphaned worktree memory directories. Implementation via `setInterval` with next-run calculation.

### Req-3: Spec watcher
Polls every 60s in batches of 4 projects (200ms inter-batch delay). Runs `openspec list --json` via `Bun.spawn()` per project (5s timeout). Detects transitions: `NewSpec`, `Removed`, `Progress`, `AllComplete`, `HashChanged`. Fires TTS notification on transitions. Warms project status cache.

## Scope
- **IN**: Unix socket server, cron service (2 jobs), spec watcher, integration with existing Bun session-manager and notification channels
- **OUT**: Removing Rust implementations (done in Phase 5), gRPC changes, credential pool changes, HTTP route changes

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/server.ts` | Add Unix socket listener alongside HTTP server |
| `apps/agent/src/services/` | New `socket-server.ts`, `cron.ts`, `spec-watcher.ts` modules |
| `apps/agent/src/session-manager.ts` | Wire socket events into existing session tracking |
| `/tmp/nexus-agent.sock` | Ownership transfers from Rust to Bun process |

## Risks
| Risk | Mitigation |
|------|-----------|
| Socket ownership conflict if both Rust and Bun try to bind | Deploy Bun-only after this phase; or use `SO_REUSEADDR` during transition |
| Bun.listen({ unix }) edge cases with rapid reconnects | Add connection error handler with backoff; test with rapid CC hook fire |
| Cron timer drift over long uptime | Use absolute next-run timestamps, not relative intervals |
