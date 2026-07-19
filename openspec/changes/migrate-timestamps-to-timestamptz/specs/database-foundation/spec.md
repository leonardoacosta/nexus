## MODIFIED Requirements

### Requirement: The credentials table MUST store values encrypted with column-level encryption metadata
The `credentials` table MUST contain `value_encrypted text NOT NULL` (replacing the former
`value_plaintext` column) and `encryption_key_id text NOT NULL DEFAULT 'v1'` to track which
encryption key version was used. A `rate_limit_count int NOT NULL DEFAULT 0` column MUST be
present to support weighted round-robin lease selection. All timestamp columns on this table
(`leasedAt`, `cooldownUntil`, `createdAt`, `updatedAt`, `expiresAt`, `usage5hResetAt`,
`usage7dResetAt`, `usagePolledAt`) MUST declare `withTimezone: true` — no bare
`timestamp({mode:'date'})` column may remain.

#### Scenario: credentials table timestamp columns are all timezone-aware
Given the `credentials` table schema in `packages/db/src/schema/credentials.ts`
When inspecting every `timestamp()` column declaration
Then each one carries `{ mode: "date", withTimezone: true }`, with none remaining bare

### Requirement: Every schema timestamp column MUST declare withTimezone: true
All `timestamp()` column declarations across `packages/db/src/schema/*.ts` MUST use
`{ mode: "date", withTimezone: true }`. This applies uniformly to every table in the schema —
not only `credentials` — so no future table introduces a bare `timestamp({mode:'date'})` column
without an explicit, documented exception.

#### Scenario: Schema-wide timestamp columns are timezone-aware
Given the full set of `packages/db/src/schema/*.ts` files
When scanning every `timestamp()` column declaration
Then all 62 declarations carry `withTimezone: true`, with zero bare `timestamp({mode:'date'})`
columns remaining

#### Scenario: Migration converts existing bare columns without shifting values
Given a Postgres database with the 43 pre-existing bare `timestamp` columns populated with real
row data
When the generated migration converts each column to `timestamp with time zone`
Then every existing row's timestamp value is unchanged (no wall-clock/UTC shift) when read back
through drizzle-orm's `postgres-js` driver with `mode: "date"`
