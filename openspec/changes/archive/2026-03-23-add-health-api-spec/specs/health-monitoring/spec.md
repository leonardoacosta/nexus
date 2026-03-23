## ADDED Requirements

### Requirement: Health Monitoring API
The agent SHALL expose a `GetHealth` RPC that returns machine health metrics including
CPU usage, memory usage, disk usage, load averages, uptime, and active session count.

#### Scenario: Health check returns accurate uptime
- **WHEN** a client calls GetHealth
- **THEN** `uptime_seconds` reflects the actual time since the agent process started
- **AND** the value is greater than 0

#### Scenario: Health response includes machine metrics
- **WHEN** a client calls GetHealth
- **THEN** the response includes `cpu_usage_percent`, `memory_used_bytes`, `memory_total_bytes`,
  `disk_used_bytes`, `disk_total_bytes`, `load_avg_1m`, `load_avg_5m`, `load_avg_15m`
- **AND** `session_count` reflects the current number of registered sessions

### Requirement: HTTP Health Endpoint
The agent SHALL expose an HTTP GET `/health` endpoint on port 7401 returning the same
health data as JSON for lightweight monitoring integrations.

#### Scenario: HTTP health check
- **WHEN** a client sends GET to `http://<agent>:7401/health`
- **THEN** a JSON response with agent_name, agent_host, uptime_seconds, session_count,
  and machine health is returned with status 200
