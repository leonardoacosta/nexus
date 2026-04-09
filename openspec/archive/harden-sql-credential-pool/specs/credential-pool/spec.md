# credential-pool — Delta: harden-sql-credential-pool

## MODIFIED Requirements

### Requirement: The system SHALL select credentials using weighted round-robin
The lease selection query MUST use Drizzle's type-safe `asc()` operator for ordering instead of
raw `sql` tagged template interpolation. The `NULLS FIRST` modifier MAY use `sql.raw()` since it
is a static SQL keyword with no interpolated values.

#### Scenario: Lease ordering uses type-safe Drizzle operators
Given the `lease()` method in `pool.ts` builds an ORDER BY clause
When the query is constructed
Then it uses `asc(credentials.rateLimitCount)` and `asc(credentials.leasedAt)` with `sql.raw('NULLS FIRST')` instead of a `sql` tagged template with column interpolation

#### Scenario: Lease behavior unchanged after migration
Given two credentials "A" (rate_limit_count=0, never leased) and "B" (rate_limit_count=2, leased yesterday)
When `lease("oauth", "caller")` is called
Then credential "A" is selected (same behavior as before migration)

## MODIFIED Requirements

### Requirement: The system SHALL poll the usage API with hybrid strategy
The `checkPrerotation()` method MUST use Drizzle's type-safe `gt()` and `gte()` operators for
the `rateLimitCount > 0` and `leasedAt >= windowStart` filters instead of raw `sql` tagged
template interpolation.

#### Scenario: Pre-rotation filter uses type-safe Drizzle operators
Given the `checkPrerotation()` method in `pool.ts` builds a WHERE clause
When the query is constructed
Then it uses `gt(credentials.rateLimitCount, 0)` and `gte(credentials.leasedAt, windowStart)` instead of `sql` tagged template with column/value interpolation

## ADDED Requirements

### Requirement: The system SHALL prevent raw SQL interpolation via CI guard
A CI-integrated lint check MUST scan TypeScript source files under `apps/` and `packages/` for
dangerous SQL patterns and fail the build if any unannoted raw interpolation is found.

#### Scenario: CI guard catches new raw SQL interpolation
Given a developer adds `db.execute(sql`SELECT * FROM ${tableName}`)` to a source file
When the CI lint check runs
Then the check fails with a message identifying the file and line number

#### Scenario: CI guard permits annotated Drizzle sql tag usage
Given a developer uses `sql` tagged template with a `// SAFE:` annotation comment on the same or preceding line
When the CI lint check runs
Then the annotated line is excluded from the check and the guard passes

#### Scenario: CI guard permits type-safe Drizzle query builder
Given a developer uses `eq()`, `gt()`, `gte()`, `asc()`, `desc()` from drizzle-orm
When the CI lint check runs
Then these usages are not flagged
