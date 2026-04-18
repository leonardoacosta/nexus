# dashboard-data-paths Specification

## Purpose
TBD - created by archiving change finalize-audit-cleanup. Update Purpose after archive.
## Requirements
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

### Requirement: Single database writer

Only `apps/agent` MAY write to the Postgres database. The dashboard (`apps/nextjs`) MUST NOT perform DB writes; all mutations originating from the dashboard MUST go through the agent's HTTP API.

#### Scenario: Dashboard creates a project

- **GIVEN** a user clicks "Add project" in the dashboard
- **WHEN** the server action handles the click
- **THEN** the action SHALL POST to the agent's `/projects` endpoint
- **AND** the action SHALL NOT call `db.insert(projects)` directly

#### Scenario: Dashboard updates settings

- **GIVEN** a user updates an agent's settings on the settings page
- **WHEN** the server action handles the form submission
- **THEN** the action SHALL PATCH the agent's `/settings` (or `/agents/:id`) endpoint
- **AND** the action SHALL NOT call `db.update(agents)` or `db.update(settings)` directly

#### Scenario: Dashboard starts a session

- **GIVEN** a user clicks "Start session" in the dashboard
- **WHEN** the server action handles the click
- **THEN** the action SHALL POST to the agent's `/session/start` endpoint (already implemented)
- **AND** the action SHALL NOT call `db.insert(sessions)` directly

### Requirement: Read-only access for dashboard

The dashboard SHALL perform DB reads ONLY via the `@nexus/db/readonly` subpath export, which exposes a `ReadOnlyDb` type that MUST omit write methods (`insert`, `update`, `delete`, `execute`, `transaction`). Direct imports of the full `Db` type from `@nexus/db` MUST NOT appear in any file under `apps/nextjs/`.

#### Scenario: Dashboard reads sessions list

- **GIVEN** the dashboard renders the sessions page
- **WHEN** the server component queries sessions
- **THEN** it SHALL use a `ReadOnlyDb`-typed client (or fetch from the agent)
- **AND** TypeScript SHALL reject any `.insert` / `.update` / `.delete` / `.execute` / `.transaction` call on that client

#### Scenario: Dashboard renders with agent stopped (still works)

- **GIVEN** all agents are offline
- **WHEN** a user loads the sessions list page
- **THEN** the page SHALL render historical sessions from the database via `ReadOnlyDb`
- **AND** the page SHALL show a banner indicating agents are offline
- **AND** SHALL NOT fail to render

### Requirement: Type-system enforcement of write boundary

The workspace ESLint config SHALL include a rule that blocks any file under `apps/nextjs/` from importing the full `Db` type or any drizzle write surface from `@nexus/db`. Only `ReadOnlyDb` (from `@nexus/db/readonly`) and named query helpers SHALL be permitted.

#### Scenario: Forbidden import fails CI

- **GIVEN** a developer adds `import { Db } from "@nexus/db"` to a file under `apps/nextjs/src/`
- **WHEN** ESLint runs in CI
- **THEN** the lint step SHALL fail with a clear message pointing to `@nexus/db/readonly` as the allowed alternative

#### Scenario: Allowed read import passes

- **GIVEN** a developer adds `import type { ReadOnlyDb } from "@nexus/db/readonly"` to a file under `apps/nextjs/src/`
- **WHEN** ESLint runs in CI
- **THEN** the lint step SHALL pass

#### Scenario: Compile-time write rejection

- **GIVEN** a `ReadOnlyDb`-typed client variable `db` in any file
- **WHEN** the developer writes `db.insert(table)`, `db.update(table)`, or `db.delete(table)`
- **THEN** TypeScript SHALL emit a compile error indicating the method does not exist on type `ReadOnlyDb`

