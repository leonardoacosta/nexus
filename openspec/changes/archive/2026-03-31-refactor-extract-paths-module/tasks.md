# Implementation Tasks

<!-- beads:epic:TBD -->

## API Batch

- [ ] [1.1] [P-1] Create `crates/nexus-core/src/paths.rs` with `pub fn home_dir() -> PathBuf` and `pub fn nexus_config_dir() -> PathBuf` [owner:api-engineer]
- [ ] [1.2] [P-1] Add `pub mod paths;` to `crates/nexus-core/src/lib.rs` [owner:api-engineer]
- [ ] [1.3] [P-2] Replace `dirs_path()` in config.rs with `crate::paths::nexus_config_dir()` and delete `dirs_path` [owner:api-engineer]
- [ ] [1.4] [P-2] Replace `home_dir()` in project_registry.rs with `crate::paths::home_dir()` and delete local `home_dir` [owner:api-engineer]
- [ ] [1.5] [P-2] Replace inline path construction in `ProjectNotes::notes_path()` with `crate::paths::nexus_config_dir().join("project-notes.toml")` [owner:api-engineer]
- [ ] [1.6] [P-2] Add unit tests for `home_dir()` and `nexus_config_dir()` [owner:api-engineer]

## E2E Batch

- [ ] [2.1] Verify `cargo build` succeeds for all workspace crates [owner:e2e-engineer]
- [ ] [2.2] Verify `cargo test` passes [owner:e2e-engineer]
- [ ] [2.3] Verify `cargo clippy` reports no new warnings [owner:e2e-engineer]
