# Change: Add native per-project status endpoints

## Why

Nova (and other consumers) need fast, low-cost project status queries. Today, reading beads state,
git status, or openspec inventory requires spinning up a full Claude Code session (~10-15s cold
start, token spend). Most status data can be gathered by running native CLI commands (`bd`, `git`,
`openspec`) directly in the project directory — sub-second, zero token cost, cacheable.

## What Changes

- New project registry service that resolves project codes (`oo`, `nx`, `co`) to filesystem paths
  using `~/.claude/scripts/config/projects.json`
- New HTTP endpoints under `/project/:code/` for beads, git, and openspec status
- New `GetProjectStatus` gRPC RPC for structured access
- Response caching (30-60s TTL) to avoid repeated subprocess spawns

## Impact

- Affected specs: none (new capability)
- Affected code:
  - `crates/nexus-agent/src/main.rs` — new HTTP routes
  - `crates/nexus-agent/src/grpc.rs` — new RPC implementation
  - `proto/nexus.proto` — new messages and RPC
  - New `crates/nexus-agent/src/services/project_status.rs` — status collection service
  - New `crates/nexus-core/src/project_registry.rs` — project code resolution
- Dependencies: None. This is a standalone addition.
- Breaking changes: None. Additive proto changes only.
