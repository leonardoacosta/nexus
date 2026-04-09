# promise-error-handling

## ADDED Requirements

### Requirement: Server Route Handler Error Safety
All `.then()` chains in `server.ts` route handlers SHALL have `.catch()` handlers that log the error with structured context and return an HTTP 500 JSON response, preventing unhandled promise rejections.

#### Scenario: Route handler throws during normal request
- **GIVEN** a GET request to `/sessions`
- **WHEN** `handleGetSessions()` throws an unexpected error
- **THEN** the `.catch()` handler logs the error with `{ route, method, error }` context
- **AND** returns a `500` response with `{ error: "internal error" }` JSON body
- **AND** no unhandled promise rejection is emitted

#### Scenario: All 15 .then() chains are protected
- **GIVEN** the full set of `.then()` chains in `createRequestHandler()`
- **WHEN** any of the 15 handler functions reject
- **THEN** each chain has a `.catch()` that returns a CORS-wrapped 500 response
- **AND** the error is logged via `@nexus/core` logger

### Requirement: Safe Fire-and-Forget Utility
A `safeFireAndForget(promise, context)` utility SHALL exist at `apps/agent/src/utils/safe-fire-and-forget.ts` that catches rejections from intentional fire-and-forget promises and logs them via the `@nexus/core` logger with the provided context string.

#### Scenario: Fire-and-forget promise succeeds
- **GIVEN** a promise that resolves successfully
- **WHEN** wrapped with `safeFireAndForget(promise, "health-tick")`
- **THEN** the promise resolves normally
- **AND** nothing is logged

#### Scenario: Fire-and-forget promise rejects
- **GIVEN** a promise that rejects with an error
- **WHEN** wrapped with `safeFireAndForget(promise, "retention-cleanup")`
- **THEN** the error is caught (not re-thrown)
- **AND** the logger emits a warning with `{ context: "retention-cleanup", error }` fields
- **AND** no unhandled promise rejection is emitted

#### Scenario: All bare void fire-and-forget patterns are replaced
- **GIVEN** the agent codebase files: health-collector.ts, health-scheduler.ts, watcher-bridge.ts, retention.ts, server.ts
- **WHEN** audited for `void <async-call>` patterns
- **THEN** each occurrence uses `safeFireAndForget()` instead of bare `void`

### Requirement: Next.js Component Promise Handling
Promise chains in Next.js components SHALL have error handling that prevents silent failures.

#### Scenario: CommandPalette fetch failure is handled
- **GIVEN** the `CommandPalette` component is open
- **WHEN** `fetchSessions()` rejects (network error, server down)
- **THEN** the error is caught via `.catch()`
- **AND** the error is logged to the console
- **AND** the component does not crash

#### Scenario: LazyTerminalPanel dynamic import failure is handled
- **GIVEN** the `LazyTerminalPanel` component is rendered
- **WHEN** the dynamic `import("./TerminalPanel")` rejects (chunk load failure)
- **THEN** Next.js `dynamic()` handles the error via its built-in error boundary
- **AND** if additional `.catch()` is needed on the `.then()` chain, it logs the error
