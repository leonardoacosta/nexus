## ADDED Requirements

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
