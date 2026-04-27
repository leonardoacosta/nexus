# agent-dispatcher-cleanup Specification

## Purpose
TBD - created by archiving change apply-4-findings. Update Purpose after archive.
## Requirements
### Requirement: Notifications settings endpoints are dispatched

The agent's HTTP dispatcher SHALL match `GET /notifications/settings` and `PATCH /notifications/settings` and invoke the existing handlers in `apps/agent/src/routes/notification-settings.ts` (`handleGetNotificationSettings`, `handlePatchNotificationSettings`). Both routes SHALL appear in the `LEGACY_DISPATCH_ROUTES` capability list so `/version` reports them.

#### Scenario: GET succeeds against a freshly-built binary

- **WHEN** a client sends `GET /notifications/settings` against a binary built from this change
- **THEN** the response status SHALL be 200
- **AND** the body SHALL be the single-row `NotificationSettingsWire` object with `tts_enabled`, `banner_enabled`, `ducking_mode`, `id`, and `updated_at` fields

#### Scenario: PATCH updates and emits SettingsChanged

- **WHEN** a client sends `PATCH /notifications/settings` with body `{"tts_enabled": false}`
- **THEN** the response status SHALL be 200
- **AND** the response body SHALL show `tts_enabled: false`
- **AND** the lifecycle bus SHALL emit a `SettingsChanged` event (verified by the existing `notification-settings.test.ts` PATCH-lifecycle scenario)

#### Scenario: /version capability list reflects both routes

- **WHEN** a client sends `GET /version` against the new binary
- **THEN** the `capabilities` array SHALL contain `"GET /notifications/settings"`
- **AND** SHALL contain `"PATCH /notifications/settings"`
- **AND** the dashboard's reachability classifier SHALL return `{ ok: true }` (no longer `stale-binary`)

### Requirement: Typed-table router scaffolding is fully removed

The unused typed-table dispatcher infrastructure SHALL be deleted. After this change, the only HTTP route dispatcher is the if/else chain in `server-request-handler.ts`.

#### Scenario: Deleted files are gone

- **WHEN** the codebase is searched for the following files
- **THEN** none of them SHALL exist:
  - `apps/agent/src/router.ts`
  - `apps/agent/src/routes.ts`
  - `apps/agent/src/routes/health.ts` (the builder; the handler at `routes/health.ts` is renamed or merged into `server-routes-health.ts`)
  - `apps/agent/src/routes/sessions-builder.ts`
  - `apps/agent/src/routes/projects-builder.ts`
  - `apps/agent/src/routes/health-history-builder.ts`
  - `apps/agent/src/routes/notifications-builder.ts`
  - `apps/agent/src/routes/credentials-builder.ts`
  - `apps/agent/src/routes/analytics-builder.ts`
  - `apps/agent/src/routes/operational-builder.ts`
  - `apps/agent/src/routes/events-builder.ts`
  - `apps/agent/src/routes/project-detail-builder.ts`
  - `apps/agent/src/routes/specs-builder.ts`
  - `apps/agent/src/routes/commands-builder.ts`
  - `apps/agent/src/routes/misc-builder.ts`

#### Scenario: No remaining references to deleted symbols

- **WHEN** the codebase is searched for `createRouter`, `RouterOptions`, `buildRoutes`, `Route\.requiresAuth`
- **THEN** the only matches SHALL be in archived spec deltas under `openspec/changes/archive/`
- **AND** there SHALL be NO matches in `apps/agent/src/`, `apps/nextjs/src/`, `tests/`, or `packages/`

#### Scenario: Build succeeds after deletions

- **WHEN** `cd apps/agent && bun run build` is invoked
- **THEN** the build SHALL succeed with exit 0
- **AND** the resulting `nexus-agent` binary SHALL serve the same routes it served before the deletions (verify by `/version` capability count — should be the same modulo the two newly-added notifications/settings entries)

#### Scenario: version-builder is preserved

- **WHEN** the deletions are complete
- **THEN** `apps/agent/src/routes/version-builder.ts` SHALL still exist
- **AND** SHALL still be imported by `server-request-handler.ts`
- **AND** SHALL produce the `/version` payload with the curated `LEGACY_DISPATCH_ROUTES` list

### Requirement: Peer connector is mounted at agent boot

The federation peer connector SHALL be invoked during agent startup in `apps/agent/src/index.ts`. The implementation MUST tolerate a missing or empty peer list (single-machine deployments are valid) and MUST NOT crash the agent on any peer failure.

#### Scenario: Connector mounts when peers are configured

- **GIVEN** `agents.toml` contains at least one peer entry that is NOT this host's `self_name`
- **WHEN** the agent starts
- **THEN** `startPeerConnector` SHALL be invoked
- **AND** SHALL log a startup line naming the peers it knows about
- **AND** SHALL NOT block the HTTP server from binding to its addresses

#### Scenario: Connector tolerates empty peer list

- **GIVEN** `agents.toml` contains only this host (no remote peers)
- **WHEN** the agent starts
- **THEN** `startPeerConnector` SHALL still be invoked
- **AND** SHALL log a single info line stating no peers configured
- **AND** SHALL NOT throw or schedule retries

#### Scenario: Connector tolerates a peer being offline

- **GIVEN** a peer in `agents.toml` is unreachable
- **WHEN** the connector attempts to dial it
- **THEN** the failure SHALL be logged at `warn` level
- **AND** the agent process SHALL NOT exit
- **AND** subsequent retries (if the implementation supports them) SHALL be backed off (no retry storm)

#### Scenario: Investigation surfaces incomplete implementation

- **GIVEN** a task agent reads `services/peer-connector.ts` and finds the implementation is incomplete or speculative
- **WHEN** the task agent attempts to wire `startPeerConnector` into `index.ts`
- **THEN** the task agent SHALL pause and surface the gap in its report rather than mounting code that crashes at runtime
- **AND** the orchestrator SHALL decide whether to fill the gap, defer, or delete the connector

### Requirement: Build artifacts are cleaned and recurrence is detected

The local `apps/agent/dist/` directory SHALL be removed. The post-merge deploy hook SHALL detect and warn (not fail) when `apps/agent/dist/` re-appears after a `bun run build`, since `bun build --compile` produces only a single binary in the package root and any `dist/` directory is artifact pollution from a previous `tsc`-style invocation.

#### Scenario: Local dist is gone

- **WHEN** `ls apps/agent/dist 2>/dev/null` is run after the cleanup task
- **THEN** the directory SHALL NOT exist

#### Scenario: Deploy hook warns on stale dist

- **GIVEN** an operator runs `deploy/hooks.d/post-merge/02-deploy --force`
- **AND** for some reason `apps/agent/dist/` exists after the `bun run build` step
- **WHEN** the hook reaches the post-build sanity check
- **THEN** the hook SHALL print a yellow warning naming the unexpected directory
- **AND** SHALL NOT exit non-zero (the warning is informational)
- **AND** the deploy SHALL continue normally

#### Scenario: Clean build does not produce a dist directory

- **WHEN** `cd apps/agent && rm -rf dist && bun run build` is invoked from a clean working tree
- **THEN** the resulting state SHALL contain `apps/agent/nexus-agent` (the compiled binary)
- **AND** SHALL NOT contain `apps/agent/dist/`

