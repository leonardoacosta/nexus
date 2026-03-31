## ADDED Requirements

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
