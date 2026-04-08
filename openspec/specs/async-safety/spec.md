# async-safety Specification

## Purpose
TBD - created by archiving change fix-blocking-reqwest-telemetry. Update Purpose after archive.
## Requirements
### Requirement: Async Telemetry Batch Send
The telemetry sync service SHALL use async `reqwest::Client` for HTTP batch sends instead of `reqwest::blocking::Client`. The `send_batch` method SHALL be a native async function without `spawn_blocking` wrappers.

#### Scenario: Telemetry batch sent without blocking thread pool
- **WHEN** the telemetry sync service flushes queued events to the API endpoint
- **THEN** the HTTP request is performed on the tokio async runtime using `reqwest::Client`
- **AND** no blocking-thread-pool slot is consumed for the network call

#### Scenario: Blocking feature removed from nexus-agent
- **WHEN** `crates/nexus-agent/Cargo.toml` is compiled
- **THEN** the `blocking` feature is NOT present in the reqwest dependency

### Requirement: Non-blocking Signal Delivery in Session Stop
The gRPC `stop_session` handler SHALL send SIGTERM, probe liveness (kill -0), and send SIGKILL using non-blocking syscalls (e.g. `nix::sys::signal::kill`) instead of spawning blocking `kill` subprocesses via `std::process::Command`.

#### Scenario: SIGTERM sent without blocking executor
- **WHEN** a gRPC client requests session stop
- **THEN** SIGTERM is delivered via a direct syscall (not a subprocess)
- **AND** the tokio executor thread is not blocked

#### Scenario: Liveness probe without blocking executor
- **WHEN** the handler polls whether the process has exited after SIGTERM
- **THEN** the kill-0 probe uses a non-blocking syscall
- **AND** the polling loop does not block the async executor on any iteration

#### Scenario: SIGKILL fallback without blocking executor
- **WHEN** the process has not exited within the 10-second grace period
- **THEN** SIGKILL is delivered via a direct syscall (not a subprocess)

### Requirement: Non-blocking Docker Container Detection in Health Collector
The health collector SHALL run `detect_docker_containers()` inside a `spawn_blocking` closure so that the synchronous `docker ps` subprocess does not block the tokio async executor.

#### Scenario: Periodic docker refresh runs inside spawn_blocking
- **WHEN** the health collector loop reaches a docker refresh tick
- **THEN** `detect_docker_containers()` executes inside the existing `spawn_blocking` closure alongside the sysinfo refresh
- **AND** the tokio async executor thread is not blocked by the docker subprocess

#### Scenario: Initial docker detection runs inside spawn_blocking
- **WHEN** the health collector starts up and collects the initial docker snapshot
- **THEN** `detect_docker_containers()` executes inside a `spawn_blocking` closure
- **AND** the tokio async executor thread is not blocked during startup

### Requirement: Server Global State Isolation
The agent server (`apps/agent/src/server.ts`) SHALL encapsulate all module-level mutable state
(`allSockets`, `pongDeadlines`, `pingTimer`, `streamManager`, `healthCollector`) inside a
`ServerState` class. `startServer()` SHALL instantiate a fresh `ServerState` on each call and
return it, so that test files receive independent instances with no shared state.

#### Scenario: Each startServer() call produces an isolated state
- **WHEN** `startServer(0)` is called twice in the same process
- **THEN** each call returns a distinct `ServerState` instance
- **AND** sockets added to one instance are not visible in the other

#### Scenario: No module-level singleton globals
- **WHEN** `apps/agent/src/server.ts` is compiled
- **THEN** `allSockets`, `pongDeadlines`, `pingTimer`, and `streamManager` are NOT declared as
  top-level `const` or `let` module variables
- **AND** they exist only as properties of `ServerState` instances

#### Scenario: Acceptance tests use isolated ServerState
- **WHEN** `apps/agent/__tests__/acceptance/api-contracts.test.ts` runs
- **THEN** it obtains its server handle via `startServer(0)` which returns a fresh `ServerState`
- **AND** `afterAll` calls `state.stop()` to cleanly release the port and stop the health collector

