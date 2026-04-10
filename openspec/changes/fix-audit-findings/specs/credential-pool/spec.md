# Capability: credential-pool

## MODIFIED Requirements

### Requirement: Parameterized SQL queries
All SQL template literals with direct string interpolation in `pool.ts` SHALL be replaced with parameterized queries using `sql.placeholder()` or Drizzle query builder.

#### Scenario: No SQL interpolation
- Given `pool.ts:115,230,332,333` use template literal interpolation in SQL
- When replaced with parameterized queries
- Then no SQL injection vectors exist in credential pool operations

### Requirement: Batch credential cleanup
The N+1 query pattern in `recoverExpiredCooldowns()` and `cleanupStaleLeases()` SHALL be replaced with batch UPDATE using `inArray()`.

#### Scenario: Single batch update replaces N individual updates
- Given 5 credentials have expired cooldowns
- When `recoverExpiredCooldowns()` runs
- Then a single UPDATE with `WHERE id IN (...)` is executed instead of 5 individual UPDATEs
