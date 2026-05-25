# db-integrity

## ADDED Requirements

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
