# Dashboard Data Paths

## ADDED Requirements

### Requirement: @nexus/db public API

`packages/db` SHALL expose a public entry point at `packages/db/src/index.ts` that re-exports inferred types, query functions, and the raw `db` client. The `package.json` `exports` field SHALL map `.` to this file.

#### Scenario: Next.js imports from the public API

- **WHEN** Next.js code writes `import { Session, getSessionsByAgent } from '@nexus/db'`
- **THEN** the import SHALL resolve to the barrel exports
- **AND** audit-scan SHALL NOT emit a B2 finding for that import

#### Scenario: Internal reach still possible in agent

- **WHEN** `apps/agent` code imports from `@nexus/db/schema/sessions` directly
- **THEN** the import SHALL still work (internal consumers are trusted)

### Requirement: Drizzle-only reads for persisted entities

Next.js code SHALL read persisted entities (projects, agents, sessions, health snapshots) exclusively through `@nexus/db`. `AgentClient` methods that return persisted-entity lists SHALL be removed.

#### Scenario: Sessions list page reads from Drizzle

- **GIVEN** the `/sessions` page in the Next.js app
- **WHEN** the page renders
- **THEN** it SHALL fetch sessions via `@nexus/db` query functions
- **AND** SHALL NOT call `AgentClient.fetchAllSessions` (which no longer exists)

#### Scenario: Agent HTTP still used for live data

- **GIVEN** the session attach page
- **WHEN** the user clicks "attach"
- **THEN** the page SHALL open a WebSocket to the agent
- **AND** the agent HTTP API SHALL remain the path for attach/exec/SSE

#### Scenario: Dashboard renders with agent stopped

- **GIVEN** all agents are offline
- **WHEN** a user loads the sessions list page
- **THEN** the page SHALL render historical sessions from the database
- **AND** the page SHALL show a banner indicating agents are offline
- **AND** SHALL NOT fail to render

### Requirement: AgentClient slim-down

`AgentClient` SHALL retain only these methods after the collapse: `attachSession`, `execCommand`, `streamEvents`, `getCurrentHealth`, `getDiscoveredProjectsOnDisk`, `getCredentialStatus`. All `fetchAll*` methods returning persisted-entity lists SHALL be deleted.

#### Scenario: Deleted method is not imported anywhere

- **WHEN** the codebase is grepped for `fetchAllSessions`, `fetchAllHealth`, `fetchAllProjects`
- **THEN** zero matches SHALL be found (including in tests)

### Requirement: Credential read boundary

Credential reads SHALL remain behind the agent HTTP API even after the collapse. Next.js SHALL NOT import credential schemas or query functions directly from `@nexus/db`.

#### Scenario: Credential access goes through agent

- **GIVEN** the credential management page in Next.js
- **WHEN** the page fetches credential metadata
- **THEN** the request SHALL go through `AgentClient.getCredentialStatus`
- **AND** SHALL NOT read from `@nexus/db` credential tables directly
