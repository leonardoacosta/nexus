# Spec: Core Post-Remediation Cleanup

## REMOVED Requirements

### Requirement: Delete orphaned tmp files
Remove `crates/nexus-core/src/tmp.9bbvAaEliZ.rs` and `crates/nexus-core/src/tmp.LT8RgrM0NP.rs` from the workspace.

#### Scenario: tmp files no longer exist after cleanup
**Given** the workspace before cleanup contains two `tmp.*.rs` files in `crates/nexus-core/src/`
**When** the cleanup is applied
**Then** neither file exists on disk and `cargo build -p nexus-core` succeeds

### Requirement: Remove dead parse_notification_config function
Remove the `parse_notification_config()` free function and its test from `notification_config.rs`.

#### Scenario: no references to parse_notification_config remain
**Given** `parse_notification_config()` exists in `notification_config.rs`
**When** the function and its test are deleted
**Then** `rg parse_notification_config crates/` returns zero matches and `cargo build` succeeds

### Requirement: Remove ConfigError NotFound variant
Remove the `NotFound(PathBuf)` variant from `ConfigError`.

#### Scenario: ConfigError compiles without NotFound
**Given** `ConfigError::NotFound` is declared but never constructed
**When** the variant is removed
**Then** `cargo build -p nexus-core` succeeds and no match arms reference `NotFound`

## MODIFIED Requirements

### Requirement: Merge notification_config into config module
The `NotificationConfig::save()` method and surviving tests MUST be moved into `config.rs`. The `notification_config.rs` file MUST be deleted. The `pub mod notification_config` line MUST be removed from `lib.rs`.

#### Scenario: save method accessible from config module
**Given** `NotificationConfig::save()` currently lives in `notification_config.rs`
**When** the method is moved to `config.rs` and the module is deleted
**Then** existing callers compile without changes because they call `save()` via method syntax on the type

#### Scenario: notification_config module removed from lib.rs
**Given** `lib.rs` declares `pub mod notification_config`
**When** the line is removed
**Then** `cargo build -p nexus-core` succeeds and `notification_config.rs` does not exist

### Requirement: Standardize agent home_dir calls
All `dirs::home_dir()` call sites in nexus-agent MUST be replaced with `nexus_core::paths::home_dir()`.

#### Scenario: agent compiles with core home_dir
**Given** nexus-agent imports `dirs::home_dir` in 6 locations
**When** all call sites are migrated to `nexus_core::paths::home_dir()`
**Then** `cargo build -p nexus-agent` succeeds and `rg 'dirs::home_dir' crates/nexus-agent/` returns zero matches

#### Scenario: dirs dependency removed if unused
**Given** `dirs` may have no remaining call sites in nexus-agent after migration
**When** no other uses of `dirs` exist in the crate
**Then** `dirs` is removed from `crates/nexus-agent/Cargo.toml`

## ADDED Requirements

### Requirement: Reverse CommandInfo proto conversion
Add `From<proto::CommandInfoProto> for CommandInfo` to complete the bidirectional conversion pattern.

#### Scenario: CommandInfo round-trips through proto
**Given** a `CommandInfo` value
**When** converted to `proto::CommandInfoProto` and back
**Then** all fields match the original (name, namespace, full_name, description, tier, cost)

#### Scenario: unknown proto tier and cost values use sensible defaults
**Given** a `proto::CommandInfoProto` with tier=0 (UNSPECIFIED) and cost=0 (UNSPECIFIED)
**When** converted to `CommandInfo`
**Then** tier defaults to `CommandTier::Status` and cost defaults to `CostCategory::Minimal`
