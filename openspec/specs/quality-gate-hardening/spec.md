# quality-gate-hardening Specification

## Purpose
TBD - created by archiving change harden-quality-gates. Update Purpose after archive.
## Requirements
### Requirement: SQL-safety lint MUST NOT false-positive on HTTP-verb template literals

`scripts/lint-sql-safety.sh` Pattern 1 SHALL NOT flag a template literal whose SQL-keyword match
is immediately followed by a `/`-prefixed route string (e.g. `` `DELETE /path -> ${status}` ``),
because that shape is an HTTP verb + route, not SQL. The gate MUST continue to flag every true
SQL-interpolation shape (`DELETE FROM ...`, `SELECT * FROM ${t}`, `UPDATE ${t} SET ...`,
`INSERT INTO ...`, `DROP TABLE ${t}`, `TRUNCATE ${t}`, `CREATE INDEX ... (${col})`).

#### Scenario: HTTP DELETE route string is not flagged

- **GIVEN** a source line `` `DELETE /elevenlabs/credentials -> ${res.status}` ``
- **WHEN** `scripts/lint-sql-safety.sh` scans the repo
- **THEN** no violation is reported for that line

#### Scenario: Genuine SQL DELETE interpolation is still flagged

- **GIVEN** an unannotated source line `` `DELETE FROM users WHERE id = ${id}` ``
- **WHEN** `scripts/lint-sql-safety.sh` scans the repo
- **THEN** a violation is reported for that line

#### Scenario: SAFE-annotated sites remain detected then excluded

- **GIVEN** a line matching a SQL-keyword + interpolation shape with a trailing `// SAFE: <reason>`
  comment
- **WHEN** the gate scans the repo
- **THEN** the line is matched by the detection regex but excluded from the violation count by the
  `// SAFE:` filter

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

### Requirement: A pre-commit guard MUST reject re-introduction of the db:push instruction

The repository's commit hook chain SHALL run a guard script that scans staged diff additions for
`db:push` / `drizzle-kit push` tokens; a line containing one of those tokens without a negation
marker (`never`, `forbid`, `banned`, `block`, `not used`, `instead of`, `do not`, `reject`) MUST
cause the guard to exit non-zero with an explanatory message. A line carrying a negation marker
(documenting the prohibition, not instructing the command) MUST be waived.

#### Scenario: A re-introduced instructive db:push line is rejected

- **GIVEN** a staged file whose added diff contains `Run pnpm --filter @nexus/db db:push first`
- **WHEN** the pre-commit guard runs
- **THEN** it exits non-zero and prints an error identifying the offending line

#### Scenario: A negated mention is waived

- **GIVEN** a staged file whose added diff contains `expect(err.message).not.toContain("db:push"); // banned (nx-vtzmd)`
- **WHEN** the pre-commit guard runs
- **THEN** it exits zero for that line

