# Proposal: Post-Remediation Cleanup Sweep (nexus-core)

## Change ID
`cleanup-core-post-remediation`

## Summary
Consolidate 6 low-risk hygiene findings in nexus-core: delete orphaned tmp files, remove dead code, merge a split impl, standardize home_dir usage, and add a missing proto conversion.

## Context
- Extends: `crates/nexus-core/src/config.rs`, `crates/nexus-core/src/notification_config.rs`, `crates/nexus-core/src/proto_convert.rs`, `crates/nexus-core/src/lib.rs`, `crates/nexus-core/src/paths.rs`
- Extends: `crates/nexus-agent/src/http_handlers.rs`, `crates/nexus-agent/src/main.rs`, `crates/nexus-agent/src/config.rs`, `crates/nexus-agent/src/cron_state.rs`, `crates/nexus-agent/src/claude_utils/project.rs`, `crates/nexus-agent/src/claude_utils/path.rs`
- Related: `remove-orphaned-tmp-files` (covers nexus-agent tmp files, not core), `refactor-add-typed-errors` (references parse_notification_config which this spec removes)

## Motivation
Post-audit sweep of nexus-core found dead code, orphaned files, a split impl, inconsistent utility usage, and a missing bidirectional conversion. Each finding is individually trivial but collectively they add noise, invite confusion, and leave the API surface incomplete. Cleaning them in one pass avoids 6 separate spec/PR cycles.

## Requirements

### Req-1: Delete orphaned tmp files (W1)
Delete `crates/nexus-core/src/tmp.9bbvAaEliZ.rs` and `crates/nexus-core/src/tmp.LT8RgrM0NP.rs`. Both are copies of `paths.rs` left over from editor operations, not registered in `lib.rs`.

### Req-2: Remove dead parse_notification_config (W2)
Remove the `parse_notification_config()` free function from `notification_config.rs`. It is a trivial one-line wrapper around `NotificationConfig::load()` with zero external consumers (confirmed via grep).

### Req-3: Remove ConfigError::NotFound variant (W3)
Remove the `ConfigError::NotFound(PathBuf)` variant from `config.rs:11`. It is declared but never constructed anywhere. `NexusConfig::load()` converts missing files through `#[from] std::io::Error` (which covers `io::ErrorKind::NotFound`), and `NotificationConfig::load()` explicitly checks `.exists()` before reading. There is no use case for a separate `NotFound` variant.

### Req-4: Merge notification_config.rs into config.rs (W4)
Move `NotificationConfig::save()` (and its test `roundtrip_save_load`) from `notification_config.rs` into `config.rs`. Delete `notification_config.rs` and remove `pub mod notification_config` from `lib.rs`. The `rules_for_fallback` test moves to config.rs tests. The `parse_notification_config_returns_result` test is deleted per Req-2.

### Req-5: Standardize agent home_dir calls (W5)
Migrate 6 call sites in nexus-agent from `dirs::home_dir()` to `nexus_core::paths::home_dir()`. The core version reads `$HOME` with `/tmp` fallback instead of returning `Option<PathBuf>`, which simplifies call sites by removing `.unwrap_or_default()` / `.ok_or()` / `if let Some(...)` patterns. After migration, remove the `dirs` dependency from nexus-agent's `Cargo.toml` if no other call sites remain.

### Req-6: Add reverse CommandInfo proto conversion (W6)
Add `From<proto::CommandInfoProto> for CommandInfo` in `proto_convert.rs` to match the bidirectional pattern already established by `Session` and `MachineHealth`. Add a round-trip test.

## Scope
- **IN**: The 6 findings listed above, all scoped to nexus-core and nexus-agent
- **OUT**: The separate `claude_utils::notification_config` module in nexus-agent (different config system), any behavioral changes to config loading, any proto schema changes

## Impact
| Area | Change |
|------|--------|
| nexus-core/src | -2 tmp files, -1 module (notification_config.rs), -1 free fn, -1 enum variant, +1 impl method (save), +1 From impl |
| nexus-core/lib.rs | -1 `pub mod` line |
| nexus-agent/src | 6 call sites: `dirs::home_dir()` -> `nexus_core::paths::home_dir()` |
| nexus-agent/Cargo.toml | Potentially remove `dirs` dependency |
| proto_convert.rs | +1 `From` impl, +1 test |

## Risks
| Risk | Mitigation |
|------|-----------|
| Removing `ConfigError::NotFound` breaks downstream match arms | Grep confirms zero match arms on `NotFound` outside `config.rs` |
| Moving `save()` breaks imports | `save()` is called via method syntax (`cfg.save()`), not module path; no import change needed |
| `dirs::home_dir()` and `nexus_core::paths::home_dir()` behave differently | Core uses `$HOME` with `/tmp` fallback; `dirs` uses platform-specific resolution. On Linux both read `$HOME`. Functional equivalence on target platform. |
| `refactor-add-typed-errors` spec references `parse_notification_config` | That spec's tasks 1.4 and 1.5 become no-ops after this cleanup; update tasks.md there or archive |
