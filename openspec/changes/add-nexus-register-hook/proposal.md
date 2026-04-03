# Add Nexus Register Hook

## Why
Claude Code needs a way to notify the agent when sessions start, stop, and remain active. The `nexus-register` binary is a Bun-compiled CLI that CC hooks invoke on SessionStart, SessionStop, and PreToolUse events. Without this hook, the file watcher has no session lifecycle signals to relay to the agent.

## What Changes
Implement a standalone CLI binary with start, stop, and heartbeat subcommands. Each invocation writes a JSON session event file to `~/.config/nexus/events/`, which the Rust file watcher detects and relays to the agent via IPC. The binary detects project context from $CWD and CC environment variables, and is compiled to a single executable via `bun build --compile`.

## Specs
See specs/ directory (if applicable).
