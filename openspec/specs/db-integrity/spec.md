# db-integrity Specification

## Purpose
TBD - created by archiving change finalize-audit-cleanup. Update Purpose after archive.
## Requirements
### Requirement: agent_id column on agent-scoped tables

`health_snapshots`, `credentials`, and `notifications` SHALL have an `agent_id text` column with a foreign key to `agents.id`. `health_snapshots.agent_id` SHALL be `NOT NULL` with `ON DELETE CASCADE`. `credentials.agent_id` and `notifications.agent_id` SHALL be nullable with `ON DELETE SET NULL`, where NULL means "shared across all agents".

#### Scenario: health_snapshots has agent_id populated

- **GIVEN** the migration has run
- **WHEN** a row is queried from `health_snapshots`
- **THEN** the row SHALL have a non-null `agent_id` referencing a valid `agents.id`
- **AND** existing pre-migration rows SHALL have been backfilled with the current sole agent's id

#### Scenario: credentials NULL agent_id means shared

- **WHEN** a credential is inserted with `agent_id = NULL`
- **THEN** the row SHALL be interpreted as "available to all agents"
- **AND** the pool query in `apps/agent/src/credentials/pool.ts` SHALL accept NULL matches

#### Scenario: Deleting an agent preserves shared credentials

- **GIVEN** an agent with 2 agent-scoped credentials and 3 shared (NULL agent_id) credentials in the pool
- **WHEN** the agent is deleted
- **THEN** the 2 agent-scoped credentials' `agent_id` SHALL be set to NULL
- **AND** the 3 shared credentials SHALL remain untouched

### Requirement: Drizzle relations for all tables

`packages/db/src/schema/*` SHALL define `relations()` for every table that participates in a foreign key. The barrel export SHALL expose these relations alongside the table definitions.

#### Scenario: Sessions has relations to project and agent

- **GIVEN** `packages/db/src/schema/sessions.ts`
- **WHEN** the file is read
- **THEN** it SHALL export a `sessionsRelations` via `relations(sessions, ({ one }) => ({ project: one(projects), agent: one(agents) }))`
- **AND** `db.query.sessions.findMany({ with: { project: true, agent: true } })` SHALL work at runtime

#### Scenario: All agent-scoped tables have relations

- **WHEN** `packages/db/src/schema/*.ts` is scanned
- **THEN** every table with an `agent_id` or `machine` FK column SHALL have a matching `relations()` definition with a `one(agents)` entry
- **AND** audit-scan SHALL report zero C10 findings

### Requirement: sessions.project_id uuid with FK

`sessions` SHALL have exactly one column referencing projects: `project_id uuid REFERENCES projects(id) ON DELETE SET NULL`. The legacy `sessions.project text NOT NULL` column and the dead `sessions.project_id text` nullable column SHALL be dropped.

#### Scenario: Schema has one project reference

- **WHEN** the sessions table is described in Postgres
- **THEN** it SHALL have a single `project_id` column with type `uuid`
- **AND** SHALL NOT have a `project` column
- **AND** SHALL have a foreign key constraint `sessions_project_id_fkey` referencing `projects(id) ON DELETE SET NULL`

#### Scenario: Migration drops old columns cleanly

- **WHEN** the generated migration runs against the current DB (0 sessions rows)
- **THEN** it SHALL `DROP COLUMN project` and `DROP COLUMN project_id` (the text variant)
- **AND** `ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE SET NULL`
- **AND** SHALL NOT require any backfill (empty table)

#### Scenario: Deleting a project nulls session references

- **GIVEN** a project with 5 historical sessions referencing it via `project_id`
- **WHEN** the project is deleted
- **THEN** all 5 sessions SHALL remain in the database
- **AND** their `project_id` column SHALL be NULL

### Requirement: Tilde expansion on projectsDir

`projectsDir` values ingested from config or user input SHALL have leading `~` expanded to the user's home directory before persistence, discovery, or path comparison. This closes nx-8v2a.

#### Scenario: User configures projectsDir with tilde

- **GIVEN** `agents.toml` contains `projectsDir = "~/dev"`
- **WHEN** the agent loads the config
- **THEN** the runtime value of `projectsDir` SHALL be `/home/<user>/dev`
- **AND** project discovery SHALL scan that directory

#### Scenario: API accepts tilde path

- **GIVEN** the registry API receives a POST with `projectsDir: "~/work"`
- **WHEN** the handler processes the request
- **THEN** the persisted value SHALL be the expanded absolute path
- **AND** the API response SHALL echo the expanded path

### Requirement: Drizzle Snapshot Reflects Custom-SQL Migration State

The Drizzle meta snapshot MUST reflect the schema state produced by the custom-SQL migrations (`0025`, `0027`, `0028`, `0029`, `0032`) so that running `drizzle-kit generate` yields a clean diff and never re-emits stale `CREATE TABLE` for already-migrated tables.

#### Scenario: Regen produces a clean diff after reconciliation

- **WHEN** a developer runs `drizzle-kit generate` against the reconciled `packages/db/drizzle/meta/` snapshot with no source-schema changes
- **THEN** the command produces no new migration (an empty or no-op diff) and emits no `CREATE TABLE` for tables already created by the custom-SQL migrations

#### Scenario: Snapshot journal records the custom-SQL migration steps

- **WHEN** the meta `_journal.json` and per-step `*_snapshot.json` files are inspected after reconciliation
- **THEN** they record the table/column state introduced by migrations `0025`, `0027`, `0028`, `0029`, and `0032`, matching the live schema

### Requirement: Regression Guard Blocks Spurious Table Creates

A regression guard or test MUST fail if a `drizzle-kit generate` (or snapshot-diff check) would emit a stale `CREATE TABLE` for an already-migrated table.

#### Scenario: Guard fails on a desynced snapshot

- **WHEN** the snapshot drifts from the applied migration state such that a regen would emit `CREATE TABLE` for an existing table
- **THEN** the guard/test fails with a clear message pointing to the desynced snapshot and the regen workflow doc

