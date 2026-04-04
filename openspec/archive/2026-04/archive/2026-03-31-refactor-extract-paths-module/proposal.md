# Proposal: Extract Shared Paths Module from Duplicated Home-Dir Logic

## Change ID
`refactor-extract-paths-module`

## Summary
Extract a single `paths.rs` module in nexus-core with `home_dir()` and `nexus_config_dir()` functions, replacing 3 independent copies of the `$HOME` -> `/tmp` fallback -> `.config/nexus` pattern.

## Context
- Extends: `crates/nexus-core/src/config.rs:214-217`, `crates/nexus-core/src/project_registry.rs:126-129`, `crates/nexus-core/src/notes.rs:49-52`
- Related: All three functions resolve `$HOME` with `/tmp` fallback and join `.config/nexus`

## Motivation
Three independent functions across config.rs (`dirs_path`), project_registry.rs (`home_dir`), and notes.rs (`notes_path`) all duplicate the same `$HOME` -> `/tmp` fallback logic. If the config directory convention changes (e.g., XDG compliance), all three must be found and updated independently. A single canonical function eliminates this duplication.

## Requirements
### Req-1: Canonical path functions
Create `pub fn home_dir() -> PathBuf` and `pub fn nexus_config_dir() -> PathBuf` in a new `paths.rs` module in nexus-core.

### Req-2: Replace all duplicated call sites
Replace `dirs_path()` in config.rs, `home_dir()` in project_registry.rs, and the inline path construction in notes.rs with calls to the new `paths` module functions.

## Scope
- **IN**: Extracting `home_dir()` and `nexus_config_dir()` into `paths.rs`, replacing 3 call sites
- **OUT**: XDG compliance, platform-specific home directory detection, adding new path helpers

## Impact
| Area | Change |
|------|--------|
| nexus-core | New `paths.rs` module (~10 lines) |
| config.rs | Replace `dirs_path()` with `crate::paths::nexus_config_dir()` |
| project_registry.rs | Replace `home_dir()` with `crate::paths::home_dir()` |
| notes.rs | Replace inline path construction with `crate::paths::nexus_config_dir()` |

## Risks
| Risk | Mitigation |
|------|-----------|
| Visibility change for private helpers | The new functions are pub within the crate; existing helpers were already private |
