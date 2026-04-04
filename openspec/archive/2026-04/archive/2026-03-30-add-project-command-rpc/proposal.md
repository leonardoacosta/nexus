# Change: Add project-routed command execution and command discovery RPC

## Why

Nova needs to dispatch slash commands against projects by name ("run `/audit:code` on `oo`") and
discover what commands are available. Today, `SendCommand` takes a raw prompt string and a session
ID — the caller must know both. There's no way to:

1. Discover available commands and their metadata (tier, description, expected cost)
2. Execute a command by project + command name without managing session lifecycle
3. Get structured command metadata for building UIs (Telegram inline keyboards, dashboards)

This proposal adds `RunProjectCommand` (project-routed execution with session pool integration) and
`ListCommands` (command discovery with metadata).

## What Changes

- New `ListCommands` gRPC RPC that reads `~/.claude/commands/` and returns command metadata
- New `RunProjectCommand` gRPC RPC that combines project resolution + session pool + execution
- Command metadata model: name, namespace, description, tier (status/analysis/action), estimated cost
- HTTP equivalents for simpler consumers

## Impact

- Affected specs: none (new capability)
- Affected code:
  - `proto/nexus.proto` — new messages and RPCs
  - `crates/nexus-agent/src/grpc.rs` — new RPC implementations
  - `crates/nexus-agent/src/main.rs` — new HTTP routes
  - New `crates/nexus-agent/src/services/command_registry.rs` — command discovery + metadata
  - New `crates/nexus-core/src/command.rs` — command metadata types
- Dependencies:
  - Requires `add-session-pool` for warm session acquisition
  - Benefits from `add-native-project-status` for project registry (fallback resolution available)
- Breaking changes: None. Additive proto changes only.
