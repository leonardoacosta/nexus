## ADDED Requirements

### Requirement: Async Telemetry Batch Send
The telemetry sync service SHALL use async `reqwest::Client` for HTTP batch sends instead of `reqwest::blocking::Client`. The `send_batch` method SHALL be a native async function without `spawn_blocking` wrappers.

#### Scenario: Telemetry batch sent without blocking thread pool
- **WHEN** the telemetry sync service flushes queued events to the API endpoint
- **THEN** the HTTP request is performed on the tokio async runtime using `reqwest::Client`
- **AND** no blocking-thread-pool slot is consumed for the network call

#### Scenario: Blocking feature removed from nexus-agent
- **WHEN** `crates/nexus-agent/Cargo.toml` is compiled
- **THEN** the `blocking` feature is NOT present in the reqwest dependency
