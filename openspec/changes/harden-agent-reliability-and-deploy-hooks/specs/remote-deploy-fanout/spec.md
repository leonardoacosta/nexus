## MODIFIED Requirements

### Requirement: DB migration on packages/db changes

A `deploy/hooks.d/post-merge/03-migrate` script MUST run `pnpm --filter @nexus/db db:migrate` (ordered migration replay — NEVER `db:push`) when files under `packages/db/` change between `ORIG_HEAD` and `HEAD`, but MUST skip entirely on a non-primary DB-writing machine regardless of whether `packages/db/` changed. The deploy is the single writer to the live DB; schema changes arrive as committed `.sql` migrations generated via `db:generate`. The script MUST load `POSTGRES_URL` from the agent's canonical source (`~/.env`). Failures log warnings but never block subsequent hooks.

#### Scenario: schema change triggers migration
- **Given** a merge introduces a new column in `packages/db/src/schema/credentials.ts`
- **When** the post-merge dispatcher runs the 03-migrate hook
- **Then** `pnpm --filter @nexus/db db:migrate` runs (applying the committed migration) and the new column appears in Postgres

#### Scenario: no DB changes skips migration
- **Given** a merge only changes `apps/nextjs/src/components/`
- **When** the post-merge dispatcher runs the 03-migrate hook
- **Then** the hook detects no `packages/db/` changes and exits early without running drizzle-kit

#### Scenario: missing POSTGRES_URL warns and exits
- **Given** `infra/.tf-outputs.env` does not exist or `POSTGRES_URL` is unset
- **When** the 03-migrate hook runs against a DB schema change
- **Then** the hook logs a warning ("POSTGRES_URL not set, skipping migration") and exits 0

#### Scenario: a non-primary machine skips migration entirely, even with a schema change

- **Given** the current machine is flagged as a non-primary DB-writing host (e.g. the Mac,
  where the homelab primary already applies the shared migration)
- **AND** a merge introduces a schema change under `packages/db/`
- **When** the post-merge dispatcher runs the 03-migrate hook
- **Then** the hook detects the non-primary role and exits early without attempting
  `db:migrate` or requiring `POSTGRES_URL` to be set locally
- **AND** no "POSTGRES_URL is required" error is logged

## ADDED Requirements

### Requirement: The post-merge deploy hook SHALL recover from a bun.lock frozen-install mismatch

`deploy/hooks.d/post-merge/02-deploy` MUST detect a `bun install --frozen-lockfile` failure
caused by lockfile drift (the committed `bun.lock` no longer matching what `bun install`
resolves) and either regenerate the lockfile safely or surface an actionable, non-silent
recovery signal — `nexus-agent` MUST NOT be left running against a stale `node_modules` with
only a buried warning as the trail.

#### Scenario: Frozen-install failure triggers actionable recovery

- **GIVEN** a merge lands and the committed `bun.lock` no longer matches what `bun install`
  would resolve
- **WHEN** `deploy/hooks.d/post-merge/02-deploy` runs `bun install --frozen-lockfile` and it
  fails with "lockfile had changes, but lockfile is frozen"
- **THEN** the hook either regenerates the lockfile (non-frozen `bun install`, committed
  separately) or surfaces a clearly actionable "manual recovery required" signal at a
  visibility level the operator will actually see (not just a buried log line)
- **AND** `nexus-agent`'s dependency sync completes or the operator is unambiguously alerted
  that it did not
