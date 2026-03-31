# Implementation Tasks

<!-- beads:epic:TBD -->

## API Batch

- [ ] [1.1] [P-1] Define `ConfigError` enum with `Io`, `Parse`, `NotFound` variants using `#[derive(thiserror::Error)]` in `crates/nexus-core/src/config.rs` [owner:api-engineer]
- [ ] [1.2] [P-2] Change `NexusConfig::load()` return type from `Box<dyn std::error::Error>` to `ConfigError` [owner:api-engineer]
- [ ] [1.3] [P-2] Change `NotificationConfig::load()` return type from `Box<dyn std::error::Error>` to `ConfigError` [owner:api-engineer]
- [ ] [1.4] [P-2] Change `NotificationConfig::save()` return type from `Box<dyn std::error::Error>` to `ConfigError` [owner:api-engineer]
- [ ] [1.5] [P-2] Change `parse_notification_config()` return type from `Box<dyn std::error::Error>` to `ConfigError` [owner:api-engineer]
- [ ] [1.6] [P-2] Update call sites in nexus-agent and nexus-tui to handle `ConfigError` (use `?` with anyhow or match) [owner:api-engineer]
- [ ] [1.7] [P-2] Export `ConfigError` from nexus-core's public API [owner:api-engineer]

## E2E Batch

- [ ] [2.1] Verify `cargo build` succeeds for all workspace crates [owner:e2e-engineer]
- [ ] [2.2] Verify `cargo test` passes [owner:e2e-engineer]
- [ ] [2.3] Verify `cargo clippy` reports no new warnings [owner:e2e-engineer]
