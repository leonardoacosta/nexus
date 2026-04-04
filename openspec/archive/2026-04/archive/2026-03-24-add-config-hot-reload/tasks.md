## 1. Config Watcher
- [ ] 1.1 Add file watcher for `~/.config/nexus/agents.toml` using `notify` crate
- [ ] 1.2 On change event: debounce (500ms) to avoid rapid re-reads
- [ ] 1.3 Re-read TOML file, parse into config struct

## 2. Config Diff
- [ ] 2.1 Compare new config against current: identify added, removed, modified entries
- [ ] 2.2 Apply changes to internal agent registry
- [ ] 2.3 Log at INFO: "config reloaded: N agents (added M, removed K, modified J)"

## 3. Validation
- [ ] 3.1 Start agent, modify agents.toml, verify log shows reload message
- [ ] 3.2 Add a new agent entry, verify it appears in agent list
- [ ] 3.3 `cargo clippy && cargo test` passes
