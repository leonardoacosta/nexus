# Implementation Tasks

<!-- beads:epic:TBD -->

## Cleanup Batch

- [ ] [1.1] [P-1] Delete `crates/nexus-core/src/tmp.9bbvAaEliZ.rs` and `crates/nexus-core/src/tmp.LT8RgrM0NP.rs` [owner:engineer]
- [ ] [1.2] [P-1] Remove `ConfigError::NotFound(PathBuf)` variant from `crates/nexus-core/src/config.rs:10-11` [owner:engineer]
- [ ] [1.3] [P-1] Remove `parse_notification_config()` function and its test `parse_notification_config_returns_result` from `notification_config.rs` [owner:engineer]
- [ ] [1.4] [P-2] Move `NotificationConfig::save()` impl (notification_config.rs:19-32) into `config.rs` after the existing `NotificationConfig` impl block [owner:engineer]
- [ ] [1.5] [P-2] Move `roundtrip_save_load` and `rules_for_fallback` tests from `notification_config.rs` into `config.rs` tests module [owner:engineer]
- [ ] [1.6] [P-3] Delete `crates/nexus-core/src/notification_config.rs` and remove `pub mod notification_config;` from `lib.rs` [owner:engineer]

## Agent Migration Batch

- [ ] [2.1] [P-1] Replace `dirs::home_dir()` with `nexus_core::paths::home_dir()` in `crates/nexus-agent/src/http_handlers.rs:459` [owner:engineer]
- [ ] [2.2] [P-1] Replace `dirs::home_dir()` with `nexus_core::paths::home_dir()` in `crates/nexus-agent/src/main.rs:300` [owner:engineer]
- [ ] [2.3] [P-1] Replace `dirs::home_dir()` with `nexus_core::paths::home_dir()` in `crates/nexus-agent/src/config.rs:11` [owner:engineer]
- [ ] [2.4] [P-1] Replace `dirs::home_dir()` with `nexus_core::paths::home_dir()` in `crates/nexus-agent/src/cron_state.rs:145` [owner:engineer]
- [ ] [2.5] [P-1] Replace `dirs::home_dir()` with `nexus_core::paths::home_dir()` in `crates/nexus-agent/src/claude_utils/project.rs:27` [owner:engineer]
- [ ] [2.6] [P-1] Replace `dirs::home_dir()` with `nexus_core::paths::home_dir()` in `crates/nexus-agent/src/claude_utils/path.rs:6` [owner:engineer]
- [ ] [2.7] [P-2] Remove `dirs` from `crates/nexus-agent/Cargo.toml` if no remaining call sites exist [owner:engineer]

## Proto Conversion Batch

- [ ] [3.1] [P-1] Add `From<proto::CommandInfoProto> for CommandInfo` impl in `crates/nexus-core/src/proto_convert.rs` with tier/cost default handling for UNSPECIFIED values [owner:engineer]
- [ ] [3.2] [P-1] Add `command_info_round_trip` test in `proto_convert.rs` tests module [owner:engineer]

## Validation Batch

- [ ] [4.1] Run `cargo build` to verify workspace compiles [owner:engineer]
- [ ] [4.2] Run `cargo test -p nexus-core` to verify all core tests pass [owner:engineer]
- [ ] [4.3] Run `cargo clippy` to verify no new warnings [owner:engineer]
