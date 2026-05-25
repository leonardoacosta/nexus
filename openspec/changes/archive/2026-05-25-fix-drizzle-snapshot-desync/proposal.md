# fix-drizzle-snapshot-desync

## Why

The Drizzle meta snapshot is desynced from the custom-SQL migrations `0025_add_cc_profiles`,
`0027_add_script_errors`, `0028_add_hook_schema_fingerprints`, `0029_add_subagent_tree_columns`,
and `0032_agent-payload-completeness-schema`. Because the snapshot under
`packages/db/drizzle/meta/` never recorded those hand-written changes, `drizzle-kit generate`
re-emits stale `CREATE TABLE` statements on the next regen — a foot-gun that corrupts every
future migration. This must be reconciled before any new migration lands.

## What Changes

Reconcile the Drizzle meta snapshot (`_journal.json` + the per-step `*_snapshot.json`) with the
actual schema produced by the custom-SQL migrations so `drizzle-kit generate` produces a clean
(empty or minimal) diff and never re-emits stale `CREATE TABLE` for already-migrated tables. Add
a regression guard/test that fails if a regen would emit spurious table creates, and document the
custom-SQL regen workflow.

## Context

- depends on: (none)
- touches: `packages/db/drizzle/meta/_journal.json`, `packages/db/drizzle/meta/`, `packages/db/src/schema`

## Non-Goals

- Rewriting or squashing the existing applied migrations `0000`-`0038` (they are already applied;
  this reconciles the snapshot, not the migration history).
- Changing the production database schema or adding new columns/tables (this is a snapshot/meta
  reconciliation, not a schema change).
- Migrating to a different ORM or migration tool.
