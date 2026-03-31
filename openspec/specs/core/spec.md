# core Specification

## Purpose
TBD - created by archiving change remove-dead-api-types. Update Purpose after archive.
## Requirements
### Requirement: HealthResponse Preserved
The system SHALL continue to export `HealthResponse` from nexus-core for use by the agent HTTP health endpoint.

#### Scenario: Agent health endpoint uses HealthResponse
- **WHEN** the agent HTTP health handler constructs a response
- **THEN** it imports and uses `nexus_core::api::HealthResponse` successfully

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

### Requirement: Typed Config Errors
The system SHALL define a `ConfigError` enum using `thiserror::Error` with variants for IO failures, TOML parse failures, and missing configuration files. All config-loading functions SHALL return this typed error instead of `Box<dyn std::error::Error>`.

#### Scenario: IO error is typed
- **WHEN** `NexusConfig::load()` fails because the config file has bad permissions
- **THEN** the error is `ConfigError::Io(std::io::Error)` and callers can match on the variant

#### Scenario: Parse error is typed
- **WHEN** `NexusConfig::load()` fails because the TOML is malformed
- **THEN** the error is `ConfigError::Parse(toml::de::Error)` and callers can match on the variant

#### Scenario: Missing file handled gracefully
- **WHEN** `NexusConfig::load()` is called and the config file does not exist
- **THEN** the error is `ConfigError::NotFound { path }` with the expected file path

#### Scenario: Notification config uses typed errors
- **WHEN** `NotificationConfig::save()` fails due to an IO error
- **THEN** the error is `ConfigError::Io(std::io::Error)`, not `Box<dyn Error>`

### Requirement: Error Compatibility with anyhow
The `ConfigError` enum SHALL implement `std::error::Error` (via thiserror) so that callers using `anyhow::Result` can convert with `?` or `.into()` without code changes.

#### Scenario: Anyhow conversion works
- **WHEN** a function returning `anyhow::Result` calls `NexusConfig::load()?`
- **THEN** the `ConfigError` is automatically converted to `anyhow::Error` via the `?` operator

### Requirement: Canonical Proto-Domain Conversions
The system SHALL provide `From` trait implementations in nexus-core for converting between domain types and proto types. Conversions SHALL cover `Session`, `MachineHealth`, `SessionStatus`, `CommandInfo`, and timestamp types. All fields SHALL be mapped correctly without silent data loss.

#### Scenario: Session round-trip preserves all fields
- **WHEN** a `Session` with `session_type: Worktree` and `tmux_target: Some("main:0")` is converted to `proto::Session` and back
- **THEN** the resulting `Session` has `session_type: Worktree` and `tmux_target: Some("main:0")`

#### Scenario: SessionStatus maps to proto enum variants
- **WHEN** a `SessionStatus::Stale` is converted to proto and back
- **THEN** the result is `SessionStatus::Stale` (not a raw i32 match)

#### Scenario: MachineHealth round-trip preserves health data
- **WHEN** a `MachineHealth` with docker containers and load averages is converted to proto and back
- **THEN** all fields including `docker_containers` and `load_avg` are preserved

### Requirement: No Duplicate Conversions Outside nexus-core
The agent and TUI crates SHALL NOT contain proto-domain conversion functions. All conversion logic SHALL live in nexus-core and be invoked via `From`/`Into` traits.

#### Scenario: Agent uses core conversions
- **WHEN** the agent serializes a session for gRPC response
- **THEN** it calls `proto::Session::from(session)` from nexus-core, not a local helper

#### Scenario: TUI uses core conversions
- **WHEN** the TUI deserializes a session from gRPC response
- **THEN** it calls `Session::from(proto_session)` from nexus-core, not a local helper

