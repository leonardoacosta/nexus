---
order: 0719d
---

# Proposal: Migrate Bare `timestamp` Columns to `timestamptz`

## Change ID
`migrate-timestamps-to-timestamptz`

## Summary
Convert the 43 remaining bare `timestamp({mode:'date'})` columns across 22 pre-2026-04-14
schema files to the fleet-standard `timestamp({mode:'date', withTimezone:true})`, closing a
schema-wide timestamp-vs-timestamptz drift (including a same-table mix inside `credentials`),
via one drizzle-kit-generated migration.

## Context
- Extends: `packages/db/src/schema/*.ts` (22 files, enumerated below), `packages/db/drizzle/`
  (migration output dir)
- Related: `improve:code` audit finding `DB-TS-DRIFT-01` (medium, M), adversarially CONFIRMED at
  base commit `c25cd89d`. 43 of 62 timestamp columns (all tables created before 2026-04-14) use
  bare `timestamp({mode:'date'})` while the 19 columns added since follow the fleet convention
  `timestamp({mode:'date',withTimezone:true})`. `credentials` itself mixes both forms
  (`leasedAt`/`cooldownUntil`/`createdAt`/`updatedAt` bare vs `expiresAt`/`usage5hResetAt`/
  `usage7dResetAt`/`usagePolledAt` withTimezone).
- touches: `packages/db/src/schema/agents.ts`, `packages/db/src/schema/bloatRadar.ts`,
  `packages/db/src/schema/ccProfileEvents.ts`, `packages/db/src/schema/ccProfiles.ts`,
  `packages/db/src/schema/credentialSwaps.ts`, `packages/db/src/schema/credentials.ts`,
  `packages/db/src/schema/cronRuns.ts`, `packages/db/src/schema/elevenlabsCredentials.ts`,
  `packages/db/src/schema/fleetPresence.ts`, `packages/db/src/schema/healthSnapshots.ts`,
  `packages/db/src/schema/hookSchemaFingerprints.ts`,
  `packages/db/src/schema/integrationCredentials.ts`,
  `packages/db/src/schema/notificationSettings.ts`, `packages/db/src/schema/notifications.ts`,
  `packages/db/src/schema/presenceHolds.ts`, `packages/db/src/schema/processWatcherState.ts`,
  `packages/db/src/schema/projectLocations.ts`, `packages/db/src/schema/projects.ts`,
  `packages/db/src/schema/routingRules.ts`, `packages/db/src/schema/scriptErrors.ts`,
  `packages/db/src/schema/sessionEvents.ts`, `packages/db/src/schema/sessions.ts`,
  `packages/db/drizzle/` (new migration), `packages/db/src/migrate.test.ts` (round-trip test)

## Motivation
A schema-wide `timestamp` vs `timestamptz` split means half the fleet's timestamp columns carry
no UTC-offset guarantee at the Postgres type level while the other half does, and one table
(`credentials`) mixes both. This is silent drift with no functional symptom today (drizzle-orm's
`postgres-js` driver with `mode:'date'` normalizes JS `Date` reads/writes identically for both
column types against a UTC-configured session), but it is a landmine for any future
cross-timezone deploy, a raw-SQL query that assumes offset-awareness, or a `\d+` schema audit
that flags the inconsistency again. Converting the 43 remaining bare columns to `timestamptz`
closes the drift in one migration while `credentials` still has both forms live.

## Requirements
### Requirement: Every schema timestamp column MUST declare `withTimezone: true`
All `timestamp()` column declarations in `packages/db/src/schema/*.ts` MUST use
`{ mode: "date", withTimezone: true }` — no bare `timestamp({mode:'date'})` column may remain
after this change.

### Requirement: The conversion migration MUST NOT shift existing timestamp values
The generated migration converting each column from `timestamp` to `timestamptz` MUST NOT alter
the wall-clock/UTC value of any existing row. Drizzle-kit's default `ALTER COLUMN ... SET DATA
TYPE timestamp with time zone` (no explicit `USING` clause) relies on Postgres interpreting the
existing naive timestamp under the session's configured timezone — this MUST be verified against
the actual generated SQL, not assumed.

## Scope
- **IN**: schema edits for all 43 bare columns across the 22 listed files; one drizzle-kit
  migration converting them; migration verified against a throwaway/local Postgres via
  `db:migrate`; a round-trip test confirming JS `Date` read/write values are unchanged.
- **OUT**: any column already declaring `withTimezone: true` (the 19 post-2026-04-14 columns,
  and the 5 multiline `credentials.ts`/`credentialPolls.ts` declarations that already carry
  `withTimezone: true` on a wrapped line); application-code changes (drizzle-orm's `mode:'date'`
  read/write behavior is unaffected by the column type change); any non-timestamp column type.

## Done Means
- All 62 schema timestamp columns declare `withTimezone: true` — zero bare
  `timestamp({mode:'date'})` remain in `packages/db/src/schema/*.ts`.
- `credentials.ts` no longer mixes bare and `withTimezone` timestamp columns.
- Session timestamps (`startedAt`, `lastActivity`, `endedAt`, etc.) render identically
  pre/post migration — no value shift, confirmed via a passing round-trip test.
- Exactly one new migration file exists under `packages/db/drizzle/` implementing the
  conversion, and it applies cleanly via `db:migrate` against a throwaway Postgres instance.

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `packages/db/src/schema/*.ts` (22 files, 43 columns) | `[1.7]` migration generation + SQL inspection | N/A — schema-only change, no user-facing flow |
| `packages/db/drizzle/` generated migration | `[1.8]` `db:migrate` against throwaway/local Postgres | N/A — infra-only, no route/component to drive |
| `postgres-js` + drizzle `mode:'date'` read/write round-trip (session timestamps) | `[1.9]` extend `packages/db/src/migrate.test.ts`, `bun test` | N/A — value-semantics check is exercised by the unit test above, not a browser flow |

## Impact
| Area | Change |
|------|--------|
| `packages/db/src/schema/*.ts` | 43 columns across 22 files gain `withTimezone: true` |
| `packages/db/drizzle/` | One new migration (`ALTER COLUMN ... SET DATA TYPE timestamp with time zone`) |
| Runtime read/write behavior | Unchanged — `postgres-js` + `mode:'date'` normalizes both column types to JS `Date` identically |

## Risks
| Risk | Mitigation |
|------|-----------|
| Drizzle-kit emits a `USING` clause or the default cast shifts stored values | Task 1.7 inspects the generated SQL before committing; task 1.9 adds a round-trip regression test |
| Migration tested against the wrong DB (shared homelab `localhost:5436` `nexus`, live multi-tenant) | Task 1.8 explicitly requires a throwaway/local Postgres instance — NEVER the shared homelab DB, per `.claude/CLAUDE.md` Persistence table (nx-vtzmd incident) |
| `db:push` used instead of the migration-based flow | Forbidden by repo policy; tasks use `db:generate` + `db:migrate` only, never `db:push` |
