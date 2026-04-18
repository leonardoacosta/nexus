# spec-page-live Specification

## Purpose
TBD - created by archiving change add-spec-page-live-updates. Update Purpose after archive.
## Requirements
### Requirement: The specs page MUST resolve the agent base URL from shared configuration
The specs page MUST NOT hardcode the agent host or port. It MUST consume a `getAgentBaseUrl()` helper that returns the same base URL as the credentials page, eliminating the current `:7402` / `:7400` mismatch.

#### Scenario: agent running on default port
- **Given** the agent listens on port 7400 and no port override is configured
- **When** the specs page renders
- **Then** its fetch targets `http://<agent-host>:7400/specs/all` and succeeds

#### Scenario: agent port overridden by configuration
- **Given** configuration sets the agent port to 7410
- **When** both the specs page and the credentials page render
- **Then** both issue requests to port 7410 (no divergence)

---

### Requirement: The specs page MUST subscribe to live transitions via SSE
On mount, the specs page MUST open an `EventSource` to `/specs/events` and merge incoming `SpecTransition` events into its local state so visible rows update without a manual reload.

#### Scenario: progress transition updates an existing row
- **Given** the specs page shows `add-user-auth` at 3/10 tasks
- **When** an SSE `progress` event arrives with `completedTasks: 7, totalTasks: 10` for that spec
- **Then** the row updates to show 7/10 without a page reload

#### Scenario: new spec appears as a row
- **Given** the specs page is open and shows 4 active specs for project `oo`
- **When** an SSE `new` event arrives for a spec `new-feature` in `oo`
- **Then** a 5th row appears at the top of the `oo` group without a reload

#### Scenario: archived spec is removed
- **Given** the specs page shows `add-user-auth` as an active spec in `oo`
- **When** an SSE `archived` event arrives for that spec
- **Then** the row is removed from the active list within 2 seconds

---

### Requirement: The SSE client MUST recover from connection drops without losing state
When the `EventSource` connection drops (network blip, server restart), the client MUST reconnect with exponential backoff and upon successful reconnect MUST refetch `/specs/all` to reconcile any transitions missed while disconnected.

#### Scenario: reconnect after transient drop
- **Given** the SSE connection drops due to a network blip
- **When** the client retries connection
- **Then** it backs off (e.g., 1s, 2s, 4s, capped at 30s) and upon successful reconnect issues one `GET /specs/all` to refresh state

#### Scenario: reconnect catches a missed transition
- **Given** the SSE was disconnected when `add-user-auth` progressed from 5/10 to 8/10
- **When** the client reconnects and refetches `/specs/all`
- **Then** the row updates to 8/10 (no transition is permanently missed)

### Requirement: Safe content rendering
The spec events subscriber component MUST NOT render arbitrary HTML via `dangerouslySetInnerHTML`. Markdown or HTML content from spec events MUST be sanitized through an allowlist before rendering.

#### Scenario: Malicious script payload
- **GIVEN** a spec event with content `<script>alert('xss')</script>`
- **WHEN** the subscriber renders the event
- **THEN** the script tag must not execute and must be stripped or escaped

### Requirement: Fetch lifecycle
All fetch and SSE subscriptions in client components MUST be tied to an AbortController scoped to component lifetime; cleanup MUST abort the connection.

#### Scenario: Component unmount mid-request
- **GIVEN** a fetch is in-flight
- **WHEN** the component unmounts
- **THEN** the fetch must be aborted and produce no state update warning

### Requirement: Module separation
The spec events subscriber MUST be split into transport, parsing, and rendering modules. The rendering component MUST NOT exceed 250 lines.

#### Scenario: Rendering module audit
- **GIVEN** the spec-events-subscriber.tsx file after the split
- **WHEN** a reviewer inspects it
- **THEN** the file contains only React rendering code (no fetch, no EventSource, no validation logic) and is under 250 lines

