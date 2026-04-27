# dashboard-data-paths Spec Delta — dashboard-agent-failover

## MODIFIED Requirements

### Requirement: Dashboard probes agent /version before treating it as unreachable

The dashboard SHALL maintain a shared helper at `apps/nextjs/src/lib/agent-reachability.ts` that probes `GET /version` on each agent in the configured registry **in DB order** and classifies the aggregate result. The helper SHALL return `{ ok: true, ... }` the moment ANY agent responds with a valid `/version` payload that satisfies `EXPECTED_CAPABILITIES`. The helper SHALL only return a failure variant when EVERY agent fails. Server actions that consume the helper SHALL accept the discriminated union and pass it through to client components.

#### Scenario: First agent responds — ok returned without probing the rest

- **GIVEN** the registry contains agents `[macbook, homelab]` in DB order
- **AND** `macbook` returns a valid `/version` payload satisfying `EXPECTED_CAPABILITIES`
- **WHEN** the dashboard helper probes the registry
- **THEN** the helper SHALL return `{ ok: true, build, capabilities, agent: macbook }`
- **AND** the helper SHALL NOT make any HTTP call to `homelab`

#### Scenario: First agent times out — second responder makes reachability ok

- **GIVEN** the registry contains agents `[macbook, homelab]` in DB order
- **AND** `macbook` times out (5s)
- **AND** `homelab` returns a valid `/version` payload satisfying `EXPECTED_CAPABILITIES`
- **WHEN** the dashboard helper probes the registry
- **THEN** the helper SHALL return `{ ok: true, build, capabilities, agent: homelab }`
- **AND** the result SHALL carry a `failover` flag indicating the active agent is NOT the first in DB order

#### Scenario: All agents fail — return the failure of the LAST attempted agent

- **GIVEN** the registry contains agents `[macbook, homelab]`
- **AND** `macbook` times out
- **AND** `homelab` returns HTTP 503
- **WHEN** the dashboard helper probes the registry
- **THEN** the helper SHALL return `{ ok: false, reason: "http-error", status: 503, agent: homelab }`
- **AND** an aggregate `attempts: [{ agent: macbook, reason: "timeout" }, { agent: homelab, reason: "http-error", status: 503 }]` SHALL be available for diagnostic display

#### Scenario: Stale binary on first agent — fall through to second

- **GIVEN** `macbook` returns `/version` with capabilities missing `"GET /credentials"`
- **AND** `homelab` returns `/version` with all required capabilities
- **WHEN** the dashboard helper probes the registry
- **THEN** the helper SHALL return `{ ok: true, ..., agent: homelab, failover: true }`
- **AND** the stale-binary classification of `macbook` SHALL NOT block ok-ness when a healthy peer exists

#### Scenario: Empty registry returns no-agent

- **GIVEN** `getAgentConfigs()` returns the localhost fallback only AND the localhost agent is unreachable
- **WHEN** the dashboard helper probes the registry
- **THEN** the helper SHALL return `{ ok: false, reason: "no-agent" }` if the registry is configurably empty, or the appropriate transport-failure variant if the localhost fallback was attempted

### Requirement: Notifications page banner copy reflects classified reachability

`apps/nextjs/src/app/notifications/NotificationsClient.tsx` SHALL hide the unreachable banner when `reachability.ok === true`, regardless of which agent answered. When the responding agent is NOT the first agent in DB order, the page SHALL surface a small "using <agent-name>" indicator near the page header to make the failover visible without alarming the user. The disabled-controls / banner copy SHALL only appear when `reachability.ok === false` (every agent failed).

#### Scenario: Failover succeeded — banner hidden, indicator shown

- **GIVEN** the page loaded with `reachability = { ok: true, agent: { name: "homelab", ... }, failover: true, ... }`
- **WHEN** the page renders
- **THEN** the unreachable banner SHALL NOT render
- **AND** controls SHALL be enabled
- **AND** an indicator showing "using homelab" SHALL render in the page header region
- **AND** the indicator SHALL NOT use error-styling — it is informational, not a warning

#### Scenario: All agents failed — banner names the last attempted agent

- **GIVEN** `reachability = { ok: false, reason: "timeout", agent: { name: "homelab", host: "100.91.88.16", port: 7400 } }`
- **WHEN** the page renders
- **THEN** the banner SHALL describe the all-agents-failed condition naming the last attempted agent's host:port
- **AND** controls SHALL be disabled

### Requirement: Credentials page consumes the same reachability classifier

`apps/nextjs/src/app/credentials/page.tsx` SHALL use the same `agent-reachability.ts` helper as the notifications page. It SHALL hide the unreachable banner when ANY agent responds, surface the same "using <name>" indicator on failover, and preserve the existing "No credentials found" empty-pool copy when the responding agent returns an empty credentials list.

#### Scenario: Failover preserves empty-pool empty-state copy

- **GIVEN** `reachability = { ok: true, agent: { name: "homelab" }, failover: true, ... }`
- **AND** `GET /credentials` against homelab returns `{ credentials: [], activeFingerprint: null }`
- **WHEN** the credentials page renders
- **THEN** the page SHALL show the "No credentials found" empty-state copy (unchanged)
- **AND** the "using homelab" indicator SHALL render in the header region
- **AND** the unreachable banner SHALL NOT render

## ADDED Requirements

### Requirement: In-memory TTL cache for the active agent

The dashboard SHALL maintain a process-scoped in-memory cache at `apps/nextjs/src/lib/agent-cache.ts` that stores the most recent successful `Reachability` result for at most 60 seconds. Subsequent reachability requests within the TTL window SHALL bypass `/version` probing and reuse the cached result. The cache SHALL store the FULL `Reachability` payload — including capabilities — so capability checks remain valid for cached responses.

#### Scenario: Within TTL — cache hit skips network

- **GIVEN** `probeAgents()` returned `{ ok: true, agent: macbook, ... }` 30 seconds ago
- **AND** the cache TTL is 60 seconds
- **WHEN** a server action calls `probeAgents()` again
- **THEN** the helper SHALL return the cached result without making any HTTP call
- **AND** the cached result SHALL be marked `cached: true` for diagnostic purposes

#### Scenario: TTL expired — cache miss reprobes

- **GIVEN** `probeAgents()` returned ok 90 seconds ago (older than 60s TTL)
- **WHEN** a server action calls `probeAgents()` again
- **THEN** the helper SHALL probe the registry from scratch starting at the first agent in DB order
- **AND** SHALL update the cache with the fresh result

#### Scenario: Failure result is NOT cached

- **GIVEN** `probeAgents()` returned `{ ok: false, reason: "timeout", ... }`
- **WHEN** a server action calls `probeAgents()` again immediately
- **THEN** the helper SHALL re-probe (NOT serve a cached failure)
- **AND** caching only applies to ok:true results

### Requirement: Transparent mid-request failover for agent fetches

The dashboard SHALL provide a wrapper at `apps/nextjs/src/lib/agent-failover.ts` exporting `withFailover<T>(fn: (agent: AgentConfig) => Promise<T>): Promise<T>`. The wrapper SHALL invoke `fn` against the cached active agent first, then on a network-class failure (timeout, connection refused, 5xx) iterate the next agent in DB order and retry. The wrapper SHALL refresh the agent-cache to point at the new responder on a successful retry, log the failover transition to server logs, and propagate the final error if all agents fail.

#### Scenario: Cached agent fails — next peer succeeds, cache updated

- **GIVEN** the cache points at `macbook`
- **AND** the registry order is `[macbook, homelab]`
- **AND** a server action calls `withFailover(agent => fetch(${agent}/notifications/settings))`
- **AND** the fetch against `macbook` rejects with a network error
- **AND** the fetch against `homelab` resolves with HTTP 200
- **WHEN** `withFailover` returns
- **THEN** the wrapper SHALL return the homelab response
- **AND** the agent-cache SHALL be updated to point at `homelab`
- **AND** a log line `[agent-failover] macbook -> homelab` SHALL be emitted

#### Scenario: Semantic 4xx is NOT a failover trigger

- **GIVEN** the cached agent returns HTTP 400 from a PATCH call (validation error)
- **WHEN** `withFailover` evaluates the response
- **THEN** the wrapper SHALL surface the 400 directly to the caller without retrying against the next peer
- **AND** the cache SHALL NOT be invalidated
- **AND** RATIONALE: a 400 is a semantic failure of the request itself; the next agent would return the same 400 against the same payload

#### Scenario: All agents fail — final error propagates

- **GIVEN** every agent in the registry returns a network error or 5xx
- **WHEN** `withFailover` exhausts the registry
- **THEN** the wrapper SHALL throw the last attempted error
- **AND** SHALL include the names of all attempted agents in the error message
- **AND** the agent-cache SHALL be cleared (next call reprobes from scratch)
