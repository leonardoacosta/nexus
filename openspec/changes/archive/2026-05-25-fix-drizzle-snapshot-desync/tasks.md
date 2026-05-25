<!-- beads:epic:nx-3du54 -->
<!-- beads:feature:nx-h1fmk -->

# Tasks: fix-drizzle-snapshot-desync

## DB Batch

- [x] [1.1] Reconcile the Drizzle meta snapshot (`packages/db/drizzle/meta/_journal.json` + the per-step `*_snapshot.json`) with the schema state produced by custom-SQL migrations `0025`/`0027`/`0028`/`0029`/`0032` so `drizzle-kit generate` yields a clean diff (no spurious `CREATE TABLE` for already-migrated tables) [owner:db-engineer] [type:db] [beads:nx-ciq0a]

## E2E Batch

- [x] [2.1] Add a regression guard/test: running `drizzle-kit generate` (or a snapshot-diff check) MUST NOT emit stale `CREATE TABLE` for the already-migrated tables; document the custom-SQL regen workflow [owner:db-engineer] [type:testing]
