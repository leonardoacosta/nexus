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

### Requirement: Cache revalidation on mutation

All Server Actions in `apps/nextjs/src/app/actions/` that perform mutations against the agent HTTP API MUST call `revalidatePath()` (or `revalidateTag()` if a tag scheme is adopted) for every route that renders the mutated data, BEFORE returning to the caller. Revalidation MUST only fire when the underlying mutation succeeds — failures must propagate to the caller without invalidating cache.

#### Scenario: Project tag update reflects in UI immediately

- **GIVEN** a user updates a project tag via the dashboard's project detail page
- **WHEN** the Server Action `updateProject` returns successfully
- **THEN** the next render of `/projects` and `/projects/[name]` MUST display the new tag without requiring a hard navigation

#### Scenario: Agent config add reflects in settings UI immediately

- **GIVEN** a user adds or removes an agent config in the dashboard's settings page
- **WHEN** the Server Action `saveAgentConfig` returns successfully
- **THEN** the next render of `/settings` MUST display the updated agent list

#### Scenario: Failed mutation does NOT invalidate cache

- **GIVEN** a Server Action mutation that fails (HTTP non-2xx or network error)
- **WHEN** the action returns or throws
- **THEN** `revalidatePath` MUST NOT have been called, and the cache MUST remain valid for the prior data

### Requirement: /notifications page MUST render table + settings strip

A new route at `/notifications` in `apps/nextjs` MUST render a single scrollable page with two components:
- A settings strip at the top containing three controls (TTS switch, Banners switch, Ducking radio group `full`/`half`/`mute`)
- A notifications table below showing recent delivered/queued/failed notifications sorted by `created_at` descending, capped at 50 rows on initial load with pagination for older rows

The page MUST be server-rendered (async server component) for the initial payload, then hydrated with a client component that maintains live state via SSE.

#### Scenario: Initial page load shows seeded settings + recent notifications

- **GIVEN** the user navigates to `http://homelab:3100/notifications`
- **WHEN** the server component mounts
- **THEN** it fetches `GET /notifications/settings` and `GET /notifications?limit=50` concurrently
- **AND** the rendered HTML contains the three controls reflecting current settings
- **AND** the table contains up to 50 most-recent rows

#### Scenario: SSE live updates prepend new rows

- **GIVEN** the user has the `/notifications` page open
- **WHEN** a new notification fires elsewhere (CC hook, manual POST, replay)
- **THEN** the client component receives the `NotificationFired` SSE frame
- **AND** prepends a new row to the top of the table within 2 seconds
- **AND** no full refetch occurs

### Requirement: Toggle controls MUST PATCH settings with optimistic UI

Each toggle (TTS switch, Banners switch, Ducking radio) MUST call `PATCH /notifications/settings` with the mutated field. The UI MUST update optimistically before the network request completes. On non-2xx response, the UI MUST roll back the optimistic state and surface a non-blocking toast indicating the failure.

#### Scenario: Successful toggle

- **GIVEN** TTS is currently on
- **WHEN** the user clicks the TTS switch to off
- **THEN** the switch UI immediately reflects "off"
- **AND** a PATCH `/notifications/settings` with `{"tts_enabled": false}` is sent
- **AND** on 200 response, the UI remains in "off" state (no visual flicker)

#### Scenario: Failed toggle rolls back

- **GIVEN** TTS is currently on
- **AND** the user clicks the switch to off
- **AND** the PATCH request returns 500
- **THEN** the switch UI reverts to "on"
- **AND** a toast appears: "Failed to update settings"
- **AND** the toast auto-dismisses within 5 seconds

### Requirement: Replay button MUST duplicate the notification

The replay button (`▶`) at the end of each row MUST POST a new notification to `/notifications/send` with:
- `id`: freshly generated (not the original)
- `title`: same as source row
- `body`: same as source row
- `channel`: same as source row
- `project`: same as source row

A replayed notification creates a new DB row, fires through the normal pipeline, and appears at the top of the table via SSE on success. The replay button MUST be disabled for rows with status `suppressed` or `expired` (no visual replay sense).

#### Scenario: Replay creates new notification

- **GIVEN** a row in the table with status `delivered`, title "Test", body "hello"
- **WHEN** the user clicks `▶`
- **THEN** a POST `/notifications/send` fires with a new id and same body/title/channel/project
- **AND** the new notification appears at the top of the table
- **AND** the source row is unchanged

#### Scenario: Replay disabled for expired rows

- **GIVEN** a row with status `expired`
- **WHEN** the user attempts to click `▶`
- **THEN** the button is disabled (not clickable)

### Requirement: Settings strip MUST be non-intrusive

The settings strip MUST occupy ≤ 120px vertical height, MUST NOT use modals or full-page takeovers for any interaction, and MUST NOT play audio previews on ducking-mode changes (preview would require ElevenLabs spend and audibly disrupt the user). Toggle interactions MUST debounce at ≥ 250ms to avoid thrashing the PATCH endpoint under rapid switching.

#### Scenario: Strip height constraint

- **WHEN** the page is rendered at any viewport width
- **THEN** the settings strip container has `max-height: 120px`

#### Scenario: No preview on ducking change

- **GIVEN** the user is on the page
- **WHEN** they change Ducking from `full` to `half`
- **THEN** no audio plays
- **AND** the change applies to the NEXT real TTS notification only

