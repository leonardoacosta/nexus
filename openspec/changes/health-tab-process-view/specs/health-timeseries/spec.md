# health-timeseries Delta

## ADDED Requirements

### Requirement: process-info-extended-fields
The `ProcessInfo` wire shape MUST gain three optional fields: `command: string | null`, `user: string | null`, and `state: string | null`. Older agents that omit these fields MUST continue to decode without breaking newer clients (optional decode). The `command` field MUST be truncated at 200 characters when the upstream value exceeds that length; a trailing ellipsis (`…`) MUST signal truncation.

#### Scenario: full process info from collector
- **Given** the host's `claude` process has command `/usr/local/bin/claude --resume abc123`
- **When** the collector samples it
- **Then** the emitted `ProcessInfo` contains `{ pid: 12345, name: "claude", cpu_percent: 23.4, ram_percent: 1.2, command: "/usr/local/bin/claude --resume abc123", user: "leonardoacosta", state: "S" }`

#### Scenario: command-line truncation
- **Given** a process with a 350-character command line (build tool with many flags)
- **When** the collector samples it
- **Then** `ProcessInfo.command` is exactly 201 characters: the first 200 of the original + `…`

#### Scenario: missing fields decode cleanly on Swift side
- **Given** a hypothetical older agent that emits `{ pid, name, cpu_percent, ram_percent }` only
- **When** the Swift `ProcessInfo` decoder reads the response
- **Then** decoding succeeds; `command`, `user`, and `state` are `nil`

### Requirement: health-processes-endpoint
The agent MUST expose `GET /health/processes` returning `{ top_cpu: ProcessInfo[], top_ram: ProcessInfo[], collectedAt: ISO-8601 }`. The endpoint MUST read from the collector's cached snapshot (no recomputation per request) and MUST accept an optional `?limit=N` query parameter constrained to `1 ≤ N ≤ 50` (default 10). Invalid `limit` values MUST return `400 { error: "limit must be 1..50" }`.

#### Scenario: default limit
- **Given** the collector cached 30 processes in both top_cpu and top_ram lists
- **When** `GET /health/processes` is called
- **Then** the response contains the top 10 entries of each list, ordered by their respective metric descending

#### Scenario: explicit limit
- **When** `GET /health/processes?limit=25` is called
- **Then** the response contains the top 25 entries of each list

#### Scenario: limit out of range
- **When** `GET /health/processes?limit=0` or `?limit=51` is called
- **Then** the response is `400 { error: "limit must be 1..50" }`

#### Scenario: collector warming up
- **Given** the agent just booted and the collector has not yet ticked
- **When** the endpoint is called
- **Then** the response is `200 { top_cpu: [], top_ram: [], collectedAt: null }` — never 500
