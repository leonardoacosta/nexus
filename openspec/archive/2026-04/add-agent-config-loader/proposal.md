# Add Agent Config Loader

## Why
The dashboard and agent need to know which peer agents exist on the Tailscale network. The v1 `agents.toml` format already defines this, but v2 needs a TypeScript parser with runtime validation and hot-reload so config changes take effect without restarting the agent or dashboard.

## What Changes
Implement a TOML parser with Zod schema validation for `~/.config/nexus/agents.toml` in `packages/core`. Add `fs.watch`-based hot-reload that detects config file changes and emits typed config-change events for downstream consumers (agent, dashboard).

## Specs
See specs/ directory (if applicable).
