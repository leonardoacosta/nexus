# Capability: async-safety

## ADDED Requirements

### Requirement: Fetch timeout utility
The system SHALL provide a `fetchWithTimeout` utility that wraps `fetch()` with `AbortController` and configurable timeout. It MUST be exported from `@nexus/core` for cross-app use.

#### Scenario: Fetch with default timeout
- Given a network request to an unresponsive endpoint
- When `fetchWithTimeout(url)` is called with default 10s timeout
- Then the request is aborted after 10 seconds
- And an AbortError is thrown

#### Scenario: Fetch with custom timeout
- Given `fetchWithTimeout(url, { timeout: 5000 })` is called
- When the endpoint does not respond within 5 seconds
- Then the request is aborted after 5 seconds

## MODIFIED Requirements

### Requirement: All fetch calls use timeout
All bare `fetch()` calls across `apps/agent/` and `apps/nextjs/` SHALL be replaced with `fetchWithTimeout()`. Estimated 64+ call sites.

#### Scenario: Agent fetch calls have timeouts
- Given bare `fetch()` calls exist in agent routes and services
- When the migration is applied
- Then all non-test fetch calls use `fetchWithTimeout()`

### Requirement: All promises have error handling
All `.then()` chains SHALL have corresponding `.catch()` handlers or MUST be converted to `async/await` with `try/catch`. Covers 27 A9 findings.

#### Scenario: Promise rejections are handled
- Given `CommandPalette.tsx:131`, `LazyTerminalPanel.tsx:6`, and `server.ts:369` have unhandled promises
- When error handling is added
- Then all promise chains include rejection handling

### Requirement: No synchronous I/O in production code
All `readFileSync`, `writeFileSync`, and `execSync` calls in non-test production code SHALL be replaced with async variants.

#### Scenario: Async file operations
- Given `event-writer.ts:9` uses synchronous file I/O
- When replaced with async variant
- Then the event loop is not blocked during file operations
