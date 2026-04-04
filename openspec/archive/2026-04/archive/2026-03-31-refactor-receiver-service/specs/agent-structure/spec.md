## ADDED Requirements

### Requirement: Receiver Module Decomposition
The receiver service module SHALL be split into focused sub-modules with single responsibilities. The `service.rs` file SHALL serve only as the thin orchestrator that wires sub-modules together via the `Service` trait implementation. All existing behavior SHALL be preserved without modification.

#### Scenario: HTTP routing extracted
- **WHEN** HTTP request handling code is moved to `http_router.rs`
- **THEN** `handle_request`, `handle_connection`, `parse_request`, and `format_response` functions live in the new module and service.rs delegates to them

#### Scenario: State management extracted
- **WHEN** `ReceiverState` and mode/type management are moved to `state.rs`
- **THEN** `ReceiverState`, `mode_query_json`, `mode_set_json`, `mode_cycle_json`, `type_set_json`, and `type_clear_json` live in the new module

#### Scenario: Socket handling extracted
- **WHEN** socket listener logic is moved to `socket.rs`
- **THEN** `handle_socket_message`, `run_socket_listener`, and related functions live in the new module

#### Scenario: Build and tests pass after refactor
- **WHEN** the refactor is complete
- **THEN** `cargo build -p nexus-agent` and `cargo test -p nexus-agent` pass with no regressions
