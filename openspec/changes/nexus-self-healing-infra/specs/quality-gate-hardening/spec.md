## MODIFIED Requirements

### Requirement: Operator-facing schema errors MUST instruct the migration-based recovery path only

The agent's `SchemaIncompleteError` and every sibling operator-facing schema-recovery doc site in this repository SHALL instruct the migration-based recovery command and MUST NOT instruct the banned push command in a non-negated context. In addition, when `verifySchema()` detects missing required tables at agent startup, it SHALL invoke `packages/db`'s already-hardened `selfHealingMigrate()` exactly once (re-exported from the package's public index for this call site) before deciding whether to fatal-exit. `selfHealingMigrate()` only replays migrations already committed under `packages/db/drizzle/` — it never generates a migration and never runs `db:push`. If the auto-migrate attempt leaves any required table still missing, the agent fatal-exits exactly as before (the fail-closed backstop from the nx-dbame incident is preserved unchanged for a genuinely broken or absent migration).

#### Scenario: SchemaIncompleteError instructs db:migrate

- **GIVEN** the agent throws `SchemaIncompleteError` because required tables are missing
- **WHEN** the error message is read
- **THEN** it contains `pnpm --filter @nexus/db db:migrate`
- **AND** it never contains the banned `db:push` or `drizzle-kit push` commands

#### Scenario: Missing tables are healed by pending, already-committed migrations

- **GIVEN** required tables are missing solely because committed migrations under
  `packages/db/drizzle/` have not yet been applied to this Postgres instance
- **WHEN** the agent starts and `verifySchema()` detects the missing tables
- **THEN** the agent calls `selfHealingMigrate()` once, which applies the pending migrations
- **AND** `verifySchema()` is re-checked and passes
- **AND** the agent proceeds to bind `:7400` without fatal-exiting

#### Scenario: Auto-migrate cannot fix a genuinely broken schema

- **GIVEN** required tables are missing for a reason `selfHealingMigrate()` cannot resolve (e.g.
  no committed migration defines the table, or the migration itself fails)
- **WHEN** the agent starts and attempts the one self-heal call
- **THEN** `verifySchema()` still reports the table(s) missing afterward
- **AND** the agent throws `SchemaIncompleteError` and exits with status 1, exactly as before this
  change
- **AND** the error message still instructs `pnpm --filter @nexus/db db:migrate` and never `db:push`

#### Scenario: NEXUS_SKIP_SCHEMA_CHECK bypasses both the check and the auto-migrate attempt

- **GIVEN** `NEXUS_SKIP_SCHEMA_CHECK=1` is set
- **WHEN** the agent starts
- **THEN** neither `verifySchema()` nor the self-heal `selfHealingMigrate()` call runs
- **AND** the agent proceeds to bind `:7400` immediately (unchanged from current behavior)
