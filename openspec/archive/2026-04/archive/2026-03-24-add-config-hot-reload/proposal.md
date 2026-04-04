## Summary

Add config hot-reload so the agent re-reads `~/.config/nexus/agents.toml` when it changes, without requiring a restart. Uses inotify on Linux and FSEvents on Mac.

## Motivation

Currently, any config change requires agent restart. Hot-reload lets users add/remove agents from the config file and have changes take effect immediately.

## Approach

1. Use the `notify` crate (already a dependency) to watch `~/.config/nexus/agents.toml`
2. On file change: re-read TOML, diff against current config, log changes
3. Apply changes: add new agent entries, remove deleted ones, update modified entries
4. Log: "config reloaded: N agents (added M, removed K)"

## Files Modified

- `crates/nexus-agent/src/main.rs` — add config file watcher
- `crates/nexus-core/src/config.rs` — add config diff logic
