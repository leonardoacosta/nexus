# quality-gate-hardening Specification

## Purpose

Defines the correctness contract for repo-wide static quality gates that guard against known
incident classes (raw SQL interpolation, the banned `db:push` command) — as opposed to the
gates' CI wiring, which is out of scope here.

## ADDED Requirements

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

The agent's `SchemaIncompleteError` and every sibling operator-facing schema-recovery doc site in this repository SHALL instruct the migration-based recovery command and MUST NOT instruct the banned push command in a non-negated context.

#### Scenario: SchemaIncompleteError instructs db:migrate

- **GIVEN** the agent throws `SchemaIncompleteError` because required tables are missing
- **WHEN** the error message is read
- **THEN** it contains `pnpm --filter @nexus/db db:migrate`
- **AND** it does not contain `db:push` or `drizzle-kit push`

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
