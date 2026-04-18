# database-foundation Specification

## Purpose
Provides the PostgreSQL database foundation for the Nexus agent: schema migrations via
Drizzle ORM, a shared `Db` handle available to all services, and the canonical schema
definitions for all tables including credentials, sessions, health snapshots, and projects.

> **Note (cross-reference):** The `encrypt-credential-storage` change (2026-04) extended the
> `credentials` table with `value_encrypted` and `encryption_key_id` columns and dropped
> `value_plaintext`. See `docs/runbook-credential-encryption.md` for the migration procedure.
## Requirements
### Requirement: The system MUST provide a SQLite database with schema migrations
The agent MUST create and manage `~/.config/nexus/nexus.db` with WAL mode enabled, schema versioning
via `PRAGMA user_version`, and a shared `NexusDb` wrapper accessible to all services.

#### Scenario: First startup creates database
Given no nexus.db exists at `~/.config/nexus/`
When the agent starts
Then it creates the database, enables WAL mode, runs all migrations to the latest version, and logs "Database initialized at version N"

#### Scenario: Subsequent startup with current version
Given nexus.db exists at version 1
When the agent starts and expects version 1
Then it skips migrations and proceeds normally

#### Scenario: Subsequent startup with older version
Given nexus.db exists at version 1
When the agent starts and expects version 2
Then it runs migration 1→2 and updates user_version to 2

#### Scenario: Database from future version
Given nexus.db exists at version 3
When the agent starts and only knows up to version 2
Then it logs an error and refuses to start (forward-compatibility guard)

### Requirement: The credentials table MUST store values encrypted with column-level encryption metadata
The `credentials` table MUST contain `value_encrypted text NOT NULL` (replacing the former
`value_plaintext` column) and `encryption_key_id text NOT NULL DEFAULT 'v1'` to track which
encryption key version was used. A `rate_limit_count int NOT NULL DEFAULT 0` column MUST be present
to support weighted round-robin lease selection.

#### Scenario: Schema migration adds encryption columns
Given nexus.db exists at version N (before this migration)
When the agent runs the schema migration
Then `value_encrypted`, `encryption_key_id`, and `rate_limit_count` columns are present in the `credentials` table and `value_plaintext` is absent

#### Scenario: One-time encryption migration script populates value_encrypted
Given the `credentials` table has rows with `value_plaintext` populated and `value_encrypted` NULL
When `scripts/encrypt-credentials.ts` is executed with valid `NEXUS_ENCRYPTION_KEY` and `POSTGRES_URL`
Then every row has `value_encrypted` populated, `encryption_key_id` set to `'v1'`, and no NULL `value_encrypted` rows remain

#### Scenario: Encryption migration script is idempotent
Given all rows already have `value_encrypted` populated
When `scripts/encrypt-credentials.ts` is executed a second time
Then no rows are modified and the script exits successfully

#### Scenario: Column drop migration requires zero NULL encrypted rows
Given `value_encrypted` has been populated for all rows
When the operator applies the column-drop migration
Then `value_plaintext` is removed and `value_encrypted NOT NULL` constraint is enforced

### Requirement: Type ownership

The Drizzle schema in `@nexus/db` MUST be the single source of truth for
entity shapes. Domain types in `@nexus/core` MUST be derived from
`$inferSelect` / `$inferInsert` via `Pick` / `Omit`, not declared
independently. Wire-protocol row interfaces (e.g. `WireCredentialRow`) MUST
live in `packages/core/src/types/`, not in Next.js action files.

#### Scenario: Adding a column to sessions table

- **GIVEN** a new column `foo` is added to `sessionsTable` in `@nexus/db`
- **WHEN** running `tsc --noEmit` across the workspace
- **THEN** any consumer of the domain `Session` type sees `foo` automatically
  without a manual update to `packages/core/src/types/session.ts`

#### Scenario: Computed runtime fields

- **GIVEN** a UI- or transport-only field like `lastHeartbeat` that is not
  stored in the DB
- **WHEN** declaring it in `@nexus/core`
- **THEN** it MUST live on a separate `SessionRuntimeFields` type that is
  intersected with the DB-derived base, not added to the domain `Session`
  interface inline

#### Scenario: Wire-row relocation

- **GIVEN** a wire-protocol superset of a domain type (e.g. `WireCredentialRow`
  widens `CredentialFile`)
- **WHEN** declaring the wire shape
- **THEN** it MUST be exported from `packages/core/src/types/`, and Next.js
  action files MUST import it from `@nexus/core`

### Requirement: No silent type casts in shape mappers

Mapper code that converts a DB row into a domain type MUST NOT use `as`
assertions to coerce string columns into TS string-literal unions
(e.g. `as Session["status"]`, `as Session["sessionType"]`). Either the column
is typed as the union at the schema level via `text({ enum: [...] })` or a
Drizzle `pgEnum`, or the mapper performs a runtime check (`switch` /
`includes`) with an explicit fallback value.

#### Scenario: Status enum drift detection

- **GIVEN** the DB `status` column's allowed values and the TS
  `Session.status` union
- **WHEN** they diverge (a value is added on one side and not the other)
- **THEN** a unit test in `packages/core` fails with an error message that
  names the diverging value and the side it was added on

#### Scenario: Mapper rewrite

- **GIVEN** the legacy mapper at `apps/nextjs/src/app/actions/sessions.ts:74-99`
- **WHEN** the change is applied
- **THEN** the mapper is either deleted (when DB-derived `Session` covers all
  fields) or reduced to a `computeSessionRuntimeFields(row)` helper that
  returns only the `SessionRuntimeFields` slice, with no `as` casts

### Requirement: Read-only enforcement at consumer layer
Every dashboard Server Action and route handler in `apps/nextjs/src/app/` that reads from the database MUST type its DB handle as `ReadOnlyDb` (from `@nexus/db/readonly`). The full `Db` type SHALL NOT be reachable from any consumer outside the factory at `apps/nextjs/src/lib/db.ts`.

#### Scenario: A new action attempts a write
- **GIVEN** a developer adds a new Server Action that calls `getReadOnlyDb()` and chains `.insert(...)`
- **WHEN** they run `pnpm tsc --noEmit`
- **THEN** TypeScript MUST fail with an error indicating `.insert` does not exist on `ReadOnlyDb`

### Requirement: Single public read API
The factory at `apps/nextjs/src/lib/db.ts` SHALL export ONLY `getReadOnlyDb()`. The full-Db function SHALL be a private helper (e.g. `_getDb()`) used internally by `getReadOnlyDb()` to obtain the underlying connection.

#### Scenario: Future consumer attempts to import getDb
- **GIVEN** a developer writes `import { getDb } from '@/lib/db'`
- **WHEN** they run `pnpm tsc --noEmit`
- **THEN** TypeScript MUST fail with an unresolved-export error

