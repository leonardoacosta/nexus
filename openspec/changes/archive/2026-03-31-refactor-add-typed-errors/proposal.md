# Proposal: Add Typed Errors Using thiserror

## Change ID
`refactor-add-typed-errors`

## Summary
Define `ConfigError` and `RegistryError` enums using `thiserror` to replace `Box<dyn std::error::Error>` in nexus-core's config and notification modules. The `thiserror` dependency is already declared but completely unused.

## Context
- Extends: `crates/nexus-core/src/config.rs`, `crates/nexus-core/src/notification_config.rs`
- Related: `thiserror` declared at `crates/nexus-core/Cargo.toml:13` but zero `#[derive(thiserror::Error)]` types exist

## Motivation
All fallible functions in nexus-core return `Box<dyn std::error::Error>` or `anyhow::Result`, making it impossible for callers to match on specific error variants (e.g., file-not-found vs parse-error vs permission-denied). The `thiserror` crate is already a dependency but never used. Typed errors enable callers to handle failures precisely and improve error messages.

## Requirements
### Req-1: ConfigError enum
Define a `ConfigError` enum with variants for IO errors, TOML parse errors, and missing config file. Use `#[derive(thiserror::Error)]`.

### Req-2: Replace Box<dyn Error> in config functions
Replace `Box<dyn std::error::Error>` return types in `NexusConfig::load()`, `NotificationConfig::load()`, `NotificationConfig::save()`, and `parse_notification_config()` with the typed error enums.

## Scope
- **IN**: `ConfigError` enum, replacing `Box<dyn Error>` in config/notification_config modules
- **OUT**: Changing error types in agent/TUI crates, replacing `anyhow::Result` usage in non-config code

## Impact
| Area | Change |
|------|--------|
| nexus-core/config.rs | Return `ConfigError` instead of `Box<dyn Error>` |
| nexus-core/notification_config.rs | Return `ConfigError` instead of `Box<dyn Error>` |
| nexus-agent, nexus-tui | Update call sites to handle `ConfigError` (may use `.into()` for anyhow) |

## Risks
| Risk | Mitigation |
|------|-----------|
| Breaking change for callers using `Box<dyn Error>` | `thiserror` types implement `std::error::Error`, so `.into()` works with anyhow |
