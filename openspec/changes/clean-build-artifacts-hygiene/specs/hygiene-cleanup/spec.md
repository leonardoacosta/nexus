# Spec: hygiene-cleanup

## MODIFIED Requirements

### Requirement: Console Warn Removal
HealthPoller.tsx SHALL NOT use `console.warn` or any other `console.*` method for error reporting in production paths.

#### Scenario: fetchHealth fails silently
**Given** the HealthPoller is mounted and polling
**When** `fetchHealth()` throws an error
**Then** the component retains the previous metrics and statuses
**And** no output is written to the browser console

### Requirement: Test Type Safety
Test files SHALL NOT use `as any` type assertions to access private class members. Tests that need internal state seeding SHALL use a dedicated test subclass or helper.

#### Scenario: discoveredProjectsMap seeded via TestAgentClient
**Given** a test needs to seed the private `discoveredProjectsMap`
**When** the test creates a `TestAgentClient` subclass instance
**Then** the subclass exposes a `seedDiscoveredProject(path, entry)` method
**And** no `as any` cast is present in the test file

### Requirement: Test File Decomposition
Test files exceeding 500 lines SHALL be split into focused modules where each module covers a single `describe` block or closely related group of tests. Shared setup (mocks, fixtures, helpers) SHALL be extracted into co-located `*.helpers.ts` files.

#### Scenario: credentials test suite split
**Given** the original `credentials.test.ts` with 1214 lines
**When** the file is decomposed
**Then** each resulting file is under 500 lines
**And** each file has a single top-level `describe` block
**And** all original tests pass without modification to assertions

#### Scenario: server test suite split
**Given** the original `server.test.ts` with 690 lines
**When** the file is decomposed
**Then** each resulting file is under 500 lines
**And** running `bun test` in apps/agent produces the same pass count

#### Scenario: agent-client test suite split
**Given** the original `agent-client.test.ts` with 527 lines
**When** the file is decomposed
**Then** each resulting file is under 500 lines
**And** running the Next.js test suite produces the same pass count

#### Scenario: projects-discovered test suite split
**Given** the original `projects-discovered.test.ts` with 523 lines
**When** the file is decomposed
**Then** each resulting file is under 500 lines
**And** all original tests pass without modification to assertions
