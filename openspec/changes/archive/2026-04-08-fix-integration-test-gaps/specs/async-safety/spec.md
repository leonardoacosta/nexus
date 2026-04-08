## ADDED Requirements

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
