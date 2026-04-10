# Capability: database-foundation

## MODIFIED Requirements

### Requirement: Timestamp columns use date mode
All timestamp columns in `packages/db/src/schema/` SHALL be migrated from `mode: "string"` to `mode: "date"`. This affects 17 column definitions across 8 schema files.

#### Scenario: Drizzle returns Date objects
- Given a timestamp column previously returned ISO strings
- When queried after migration
- Then the column value is a JavaScript Date object
- And all consuming code handles Date objects correctly

#### Scenario: Migration is generated
- Given 17 timestamp columns are updated to `mode: "date"`
- When `drizzle-kit generate` runs
- Then a migration is produced (schema metadata change, no SQL ALTER needed for mode-only changes)

### Requirement: Credentials table has audit fields
The `credentials` table SHALL gain `createdAt` and `updatedAt` timestamp columns for debugging rotation lifecycle.

#### Scenario: Audit fields on credentials
- Given the credentials table lacks timestamp metadata
- When the migration is applied
- Then `createdAt` defaults to `now()` and `updatedAt` is set on every update
