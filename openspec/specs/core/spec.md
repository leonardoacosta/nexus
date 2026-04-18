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
The system SHALL provide `From` trait implementations in nexus-core for converting between domain
types and proto types. Conversions SHALL cover `Session`, `MachineHealth`, `SessionStatus`,
`CommandInfo`, and timestamp types. All fields SHALL be mapped correctly without silent data loss.
The `SessionStatus` proto enum SHALL include an `ENDED` variant that maps to and from
`SessionStatus::Ended`.

#### Scenario: Session round-trip preserves all fields
- **WHEN** a `Session` with `session_type: Worktree` and `tmux_target: Some("main:0")` is converted to `proto::Session` and back
- **THEN** the resulting `Session` has `session_type: Worktree` and `tmux_target: Some("main:0")`

#### Scenario: SessionStatus maps to proto enum variants
- **WHEN** a `SessionStatus::Stale` is converted to proto and back
- **THEN** the result is `SessionStatus::Stale` (not a raw i32 match)

#### Scenario: SessionStatus::Ended maps to proto ENDED
- **WHEN** a `SessionStatus::Ended` is converted to `proto::SessionStatus`
- **THEN** the result is `proto::SessionStatus::Ended`

#### Scenario: proto ENDED maps to SessionStatus::Ended
- **WHEN** a `proto::SessionStatus::Ended` is converted to `SessionStatus`
- **THEN** the result is `SessionStatus::Ended`

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

### Requirement: SessionStatus MUST include an Ended variant
The `SessionStatus` enum in `nexus-core/src/session.rs` SHALL include an `Ended` variant. The
variant MUST serialize to `"ended"` via serde (using the existing `#[serde(rename_all =
"snake_case")]` attribute). All match arms on `SessionStatus` throughout the workspace MUST be
exhaustive, covering `Active`, `Idle`, `Stale`, `Errored`, and `Ended`.

#### Scenario: Ended serializes to "ended"
- **WHEN** a `Session` with `status: SessionStatus::Ended` is serialized to JSON
- **THEN** the `status` field value is `"ended"`

#### Scenario: "ended" deserializes to Ended
- **WHEN** a JSON payload with `"status": "ended"` is deserialized into `SessionStatus`
- **THEN** the result is `SessionStatus::Ended`

#### Scenario: Non-exhaustive match is a compile error
- **WHEN** a `match session.status` block does not include an `Ended` arm
- **THEN** the Rust compiler produces an error before the binary is built

### Requirement: SessionType MUST serialize via Display not Debug
The `SessionType` enum SHALL implement `std::fmt::Display` producing `"ad_hoc"`, `"managed"`, or
`"pooled"`. Database and API serialization of `session_type` SHALL use this `Display`
implementation. The `{:?}` debug format SHALL NOT be used for serialization.

#### Scenario: Display produces ad_hoc not adhoc
- **WHEN** `format!("{}", SessionType::AdHoc)` is evaluated
- **THEN** the result is `"ad_hoc"`

#### Scenario: Managed Display
- **WHEN** `format!("{}", SessionType::Managed)` is evaluated
- **THEN** the result is `"managed"`

#### Scenario: DB write uses Display value
- **WHEN** a session with `session_type = SessionType::AdHoc` is written to the database
- **THEN** the stored value is `"ad_hoc"`, not `"AdHoc"` or `"adhoc"`

### Requirement: Package exports
The `@nexus/core` package SHALL expose two distinct entry points: a browser-safe default barrel and a node-only `./node` subpath. The default entry (`@nexus/core`) SHALL only export symbols whose transitive imports are safe in a browser environment — types, zod schemas, and string constants. The `@nexus/core/node` subpath SHALL export node-runtime helpers (`safeSpawn`, `expandTilde`, `parseConfig`, `logger`, `createLogger`, and the config/spawn schemas and error types). The pre-existing `@nexus/core/fetch` subpath SHALL remain unchanged.

#### Scenario: Browser code imports types
- **GIVEN** a `"use client"` component in `apps/nextjs/`
- **WHEN** it imports any symbol from `@nexus/core` (e.g., `SpecTransitionEvent`, `specEventsFrameSchema`)
- **THEN** the resulting webpack bundle MUST NOT contain references to `node:os`, `node:path`, `node:fs`, or `child_process`
- **AND** `next build` MUST succeed without "Module not found" errors

#### Scenario: Agent code imports node helpers
- **GIVEN** a Bun runtime file in `apps/agent/`
- **WHEN** it needs `safeSpawn`, `parseConfig`, `expandTilde`, `logger`, `createLogger`, or any of the moved schemas/error types
- **THEN** it MUST import from `@nexus/core/node`, not from `@nexus/core`
- **AND** `tsc --noEmit` MUST succeed across the workspace

#### Scenario: Browser barrel rejects node imports
- **GIVEN** a contributor edits `packages/core/src/index.ts` to re-export from `./safe-spawn`, `./config`, `./logger`, `./path`, or `./node`
- **WHEN** the lint step runs (`pnpm lint` or `eslint .` in `packages/core`)
- **THEN** the lint MUST fail with a `no-restricted-imports` violation pointing at the offending line

### Requirement: Type definitions remain canonical
All types and schemas exported by `@nexus/core` SHALL have exactly one source-of-truth definition in `packages/core/src/types/`. No file in `apps/nextjs/`, `apps/agent/`, or any other workspace package SHALL contain a duplicate or hand-rewritten copy of a type that `@nexus/core` already exports.

#### Scenario: spec-events-subscriber uses the canonical type
- **GIVEN** `apps/nextjs/src/app/specs/spec-events-subscriber.tsx`
- **WHEN** the file references `SpecTransitionEvent` or `SpecEventsFrame`
- **THEN** the type MUST be imported from `@nexus/core` (not redeclared inline)
- **AND** the file MUST NOT contain a "Keep this in sync with the core source of truth" comment or any equivalent manual-sync marker

#### Scenario: Audit catches future duplicates
- **GIVEN** any `.ts` or `.tsx` file in `apps/`
- **WHEN** a grep for `type SpecTransitionEvent`, `interface SpecEventsFrame`, or any other type name exported by `@nexus/core` runs against `apps/`
- **THEN** zero results MUST be returned (the only declaration site is `packages/core/src/types/`)

