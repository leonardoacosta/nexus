## ADDED Requirements

### Requirement: Canonical Path Resolution Module
The system SHALL provide a `paths` module in nexus-core with `pub fn home_dir() -> PathBuf` and `pub fn nexus_config_dir() -> PathBuf`. `home_dir()` SHALL resolve `$HOME` with `/tmp` fallback. `nexus_config_dir()` SHALL return `home_dir().join(".config/nexus")`.

#### Scenario: home_dir reads HOME env var
- **WHEN** `$HOME` is set to `/home/testuser`
- **THEN** `home_dir()` returns `/home/testuser`

#### Scenario: home_dir falls back to /tmp
- **WHEN** `$HOME` is not set
- **THEN** `home_dir()` returns `/tmp`

#### Scenario: nexus_config_dir returns config path
- **WHEN** `$HOME` is set to `/home/testuser`
- **THEN** `nexus_config_dir()` returns `/home/testuser/.config/nexus`

### Requirement: No Duplicate Path Resolution
The modules `config.rs`, `project_registry.rs`, and `notes.rs` SHALL NOT contain their own home directory or config directory resolution logic. They SHALL use the canonical `paths` module functions.

#### Scenario: config.rs uses paths module
- **WHEN** `NexusConfig::load()` resolves the config file path
- **THEN** it calls `crate::paths::nexus_config_dir()`, not a local `dirs_path()` function

#### Scenario: project_registry.rs uses paths module
- **WHEN** the project registry resolves file paths
- **THEN** it calls `crate::paths::home_dir()`, not a local `home_dir()` function

#### Scenario: notes.rs uses paths module
- **WHEN** `ProjectNotes` resolves the notes file path
- **THEN** it calls `crate::paths::nexus_config_dir()`, not inline `$HOME` resolution
