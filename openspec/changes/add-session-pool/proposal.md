# Change: Add warm session pool for fast command execution

## Why

`SendCommand` requires an existing session ID. For on-demand command execution (e.g., Nova asking
"run `/audit:code` on oo"), the current path is: `StartSession` (10-15s cold start) → wait for
bootstrap → `SendCommand` → `StopSession`. This latency and cost makes interactive command
dispatching impractical.

A warm session pool keeps 1 managed CC session per active project, idle but alive, ready to accept
commands via `SendCommand` within milliseconds. The session has full project context (CLAUDE.md,
beads, git) already loaded.

## What Changes

- New `SessionPool` service that manages warm CC sessions per project
- On-demand session creation: first command for a project triggers pool creation
- Idle timeout with configurable eviction (default 15 minutes of no commands)
- Health checking: detect crashed or stale pooled sessions and replace them
- `SendCommand` integration: when called with a project code instead of session ID, the pool
  provides (or creates) a warm session

## Impact

- Affected specs: none (new capability)
- Affected code:
  - New `crates/nexus-agent/src/services/session_pool.rs` — pool lifecycle management
  - `crates/nexus-agent/src/grpc.rs` — extend SendCommand to accept project routing
  - `crates/nexus-agent/src/registry.rs` — track pooled sessions distinctly
  - `crates/nexus-core/src/session.rs` — add `SessionType::Pooled` variant
  - `proto/nexus.proto` — extend `CommandRequest` with optional project field
  - Config: pool settings in `agents.toml`
- Dependencies: benefits from `add-native-project-status` (project registry), but can use
  standalone project resolution as fallback
- Breaking changes: None. Proto changes are additive (new optional field on CommandRequest).
