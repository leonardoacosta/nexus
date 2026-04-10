# Error Handling Sweeps

## ADDED Requirements

### Requirement: No unhandled Promise rejections

All `.then()` calls in production code SHALL either (a) chain a `.catch()` that reports to Sentry, or (b) be replaced with `await` inside a `try/catch`. Documented intentional swallows SHALL use `.catch(noop)` with a comment explaining why.

#### Scenario: session-manager promise has catch handler

- **GIVEN** `apps/agent/src/session-manager.ts`
- **WHEN** the file is read
- **THEN** every `.then()` at lines 303, 304 SHALL have a matching `.catch()`
- **AND** audit-scan SHALL report zero A9 findings for the file

#### Scenario: watcher-bridge promise has catch handler

- **GIVEN** `apps/agent/src/watcher-bridge.ts`
- **WHEN** the file is read
- **THEN** every `.then()` at lines 118, 167 SHALL have a matching `.catch()`

#### Scenario: Dashboard component handles promise

- **GIVEN** `apps/nextjs/src/components/CommandPalette.tsx` and `LazyTerminalPanel.tsx`
- **WHEN** the files are read
- **THEN** every `.then()` SHALL have a matching `.catch()` that surfaces error state to the user

### Requirement: streamManager SIGTERM cleanup

The PTY `streamManager` SHALL subscribe to the agent process `SIGTERM` handler and invoke `shutdown()` on all active streams before the process exits. This closes nx-acu2.

#### Scenario: Agent receives SIGTERM with active streams

- **GIVEN** 3 active PTY streams managed by `streamManager`
- **WHEN** the agent process receives SIGTERM
- **THEN** `streamManager.shutdown()` SHALL be called
- **AND** all 3 PTY processes SHALL receive SIGTERM themselves
- **AND** the agent process SHALL NOT exit until all streams have reported closure or 5 seconds have elapsed

### Requirement: console.error migration to Sentry

All `console.error` calls in production code SHALL migrate to `Sentry.captureException` (for caught errors) or `Sentry.captureMessage` (for logged warnings).

#### Scenario: CommandPalette error is reported

- **GIVEN** `apps/nextjs/src/components/CommandPalette.tsx:136`
- **WHEN** the file is read
- **THEN** the `console.error` SHALL be replaced with `Sentry.captureException`

### Requirement: SQL placeholder migration

All SQL template literals in `apps/agent/src/credentials/pool.ts` SHALL use `sql.placeholder()` or Drizzle's typed query builder, never string interpolation.

#### Scenario: Credential pool query is parameterized

- **GIVEN** `apps/agent/src/credentials/pool.ts:119`
- **WHEN** the file is read
- **THEN** the query SHALL use `sql.placeholder('name')` or `db.select().from().where(eq(...))`
- **AND** SHALL NOT contain `sql\`...${variable}...\`` interpolation patterns

### Requirement: Production fetch timeout

All production-path `fetch()` calls in `apps/agent/` and `packages/core/` SHALL use `fetchWithTimeout` from `@nexus/core/fetch`.

#### Scenario: credentials route uses fetchWithTimeout

- **GIVEN** `apps/agent/src/routes/credentials.ts:302`
- **WHEN** the file is read
- **THEN** the `fetch()` call SHALL be `fetchWithTimeout(...)` with an explicit timeout
