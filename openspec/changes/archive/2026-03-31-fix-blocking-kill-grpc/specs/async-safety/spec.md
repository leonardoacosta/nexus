## ADDED Requirements

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
