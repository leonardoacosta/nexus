# Spec: remove-dead-code

## REMOVED Requirements

### Requirement: Stale dead-code annotations removed from client.rs
The 6 `#[allow(dead_code)]` annotations in `crates/nexus-tui/src/client.rs` (on `get_session`, `stop_session`, `get_health_time_series`, `get_session_history`, `get_failure_trends`, `get_spec_velocity`) MUST be removed — all methods have active callers in main.rs and stream.rs.

#### Scenario: Methods compile without dead_code suppression
- **GIVEN** the annotations are removed
- **WHEN** running `cargo check -p nexus-tui`
- **THEN** no dead_code warnings are emitted for these 6 methods

### Requirement: Truly dead rename_pool_credential removed
The `rename_pool_credential` function (~40 lines at line 958 of `crates/nexus-agent/src/services/credential_pool.rs`) MUST be deleted — it has zero callers anywhere in the codebase.

#### Scenario: credential_pool compiles without rename_pool_credential
- **GIVEN** the function is removed
- **WHEN** running `cargo check -p nexus-agent`
- **THEN** no compilation errors and no references to `rename_pool_credential` exist in the codebase
