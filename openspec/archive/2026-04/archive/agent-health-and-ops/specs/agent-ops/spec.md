## ADDED Requirements

### Requirement: Machine Health Collection

The agent SHALL collect machine health metrics using the sysinfo crate and populate a
`MachineHealth` struct with: cpu_percent, memory_used_gb, memory_total_gb, disk_used_gb,
disk_total_gb, load_avg (array of 3 floats for 1/5/15 min), and uptime_seconds.

The agent SHALL refresh health metrics on a background interval (every 5 seconds) and
store the latest snapshot in shared state accessible to both the HTTP and gRPC servers.

#### Scenario: Health metrics collected on startup

- **WHEN** the agent starts
- **THEN** a background task begins collecting MachineHealth every 5 seconds
- **AND** the first snapshot is available within 5 seconds of startup

#### Scenario: CPU and memory values are populated

- **WHEN** health metrics are collected
- **THEN** cpu_percent is between 0.0 and 100.0
- **AND** memory_used_gb is less than or equal to memory_total_gb
- **AND** memory_total_gb is greater than 0

### Requirement: Docker Container Detection

The agent SHALL optionally detect running Docker containers by executing `docker ps --format json`
and parsing the output into a `Vec<ContainerStatus>` (name, running boolean).

If Docker is not installed or the command fails, the agent SHALL set
`docker_containers` to `None` rather than returning an error.

#### Scenario: Docker is available

- **WHEN** Docker is installed and the daemon is running
- **THEN** docker_containers contains a list of ContainerStatus entries
- **AND** each entry has a name and running status

#### Scenario: Docker is not available

- **WHEN** Docker is not installed or the daemon is not running
- **THEN** docker_containers is None
- **AND** the health collection does not fail

### Requirement: HTTP Health Endpoint

The agent SHALL expose an HTTP GET `/health` endpoint on port 7401 using axum.
The response SHALL be a JSON-serialized `HealthResponse` containing agent_name,
agent_host, uptime_seconds, session_count, and the latest MachineHealth snapshot.

This endpoint SHALL be separate from the gRPC server on port 7400 to support
curl and monitoring tool compatibility.

#### Scenario: Curl health check

- **WHEN** a client sends GET to `http://<host>:7401/health`
- **THEN** the response status is 200
- **AND** the body is valid JSON matching HealthResponse schema
- **AND** machine health data is included

### Requirement: StopSession RPC

The agent SHALL implement a `StopSession` gRPC RPC that terminates a running
Claude Code session by process ID.

The RPC SHALL send SIGTERM to the session's PID, wait up to 10 seconds for the
process to exit, and send SIGKILL if the process is still running after the timeout.

The RPC SHALL return the final session status after termination.
The RPC SHALL return NOT_FOUND if the session_id does not exist in the registry.

#### Scenario: Graceful stop with SIGTERM

- **WHEN** StopSession is called with a valid session_id
- **AND** the process exits within 10 seconds of SIGTERM
- **THEN** the session status is updated to reflect termination
- **AND** the session is removed from the registry
- **AND** the response includes the final session state

#### Scenario: Forced stop with SIGKILL

- **WHEN** StopSession is called with a valid session_id
- **AND** the process does not exit within 10 seconds of SIGTERM
- **THEN** SIGKILL is sent to the process
- **AND** the session is removed from the registry

#### Scenario: Session not found

- **WHEN** StopSession is called with a session_id not in the registry
- **THEN** the RPC returns a NOT_FOUND error

### Requirement: StartSession RPC

The agent SHALL implement a `StartSession` gRPC RPC that spawns a new Claude Code
session inside a tmux session.

The tmux session SHALL be named `nx-<short-id>` where short-id is the first 8
characters of the generated session UUID.

The command executed inside tmux SHALL be `claude [args]` where args are provided
by the RPC request.

The RPC SHALL return the session_id and tmux_session name.
The RPC SHALL return FAILED_PRECONDITION if tmux is not available on PATH.

#### Scenario: Start a new managed session

- **WHEN** StartSession is called with args (e.g., project path)
- **AND** tmux is available on PATH
- **THEN** a new tmux session is created with name `nx-<8-char-uuid>`
- **AND** `claude [args]` is running inside the tmux session
- **AND** the session is registered in the registry with tmux_session set
- **AND** the response contains session_id and tmux_session name

#### Scenario: tmux not available

- **WHEN** StartSession is called
- **AND** tmux is not found on PATH
- **THEN** the RPC returns FAILED_PRECONDITION with message indicating tmux is required

### Requirement: Managed Session Tracking

The agent registry SHALL distinguish managed sessions (started via StartSession RPC)
from discovered sessions (found via file watching).

A session SHALL be considered managed when its `tmux_session` field is `Some(name)`.
Managed sessions SHALL be tracked in the same registry as discovered sessions.

#### Scenario: Managed session registered

- **WHEN** StartSession creates a new session
- **THEN** the session appears in the registry with tmux_session set to the tmux session name
- **AND** the session is included in GetSessions responses

#### Scenario: Managed session stopped

- **WHEN** StopSession terminates a managed session
- **THEN** the session is removed from the registry
- **AND** the tmux session is killed
