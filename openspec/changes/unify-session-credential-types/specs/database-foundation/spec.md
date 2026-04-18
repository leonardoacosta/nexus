# database-foundation Spec Delta — unify-session-credential-types

## MODIFIED Requirements

### Requirement: Type ownership

The Drizzle schema in `@nexus/db` MUST be the single source of truth for
entity shapes. Domain types in `@nexus/core` MUST be derived from
`$inferSelect` / `$inferInsert` via `Pick` / `Omit`, not declared
independently. Wire-protocol row interfaces (e.g. `WireCredentialRow`) MUST
live in `packages/core/src/types/`, not in Next.js action files.

#### Scenario: Adding a column to sessions table

- **GIVEN** a new column `foo` is added to `sessionsTable` in `@nexus/db`
- **WHEN** running `tsc --noEmit` across the workspace
- **THEN** any consumer of the domain `Session` type sees `foo` automatically
  without a manual update to `packages/core/src/types/session.ts`

#### Scenario: Computed runtime fields

- **GIVEN** a UI- or transport-only field like `lastHeartbeat` that is not
  stored in the DB
- **WHEN** declaring it in `@nexus/core`
- **THEN** it MUST live on a separate `SessionRuntimeFields` type that is
  intersected with the DB-derived base, not added to the domain `Session`
  interface inline

#### Scenario: Wire-row relocation

- **GIVEN** a wire-protocol superset of a domain type (e.g. `WireCredentialRow`
  widens `CredentialFile`)
- **WHEN** declaring the wire shape
- **THEN** it MUST be exported from `packages/core/src/types/`, and Next.js
  action files MUST import it from `@nexus/core`

### Requirement: No silent type casts in shape mappers

Mapper code that converts a DB row into a domain type MUST NOT use `as`
assertions to coerce string columns into TS string-literal unions
(e.g. `as Session["status"]`, `as Session["sessionType"]`). Either the column
is typed as the union at the schema level via `text({ enum: [...] })` or a
Drizzle `pgEnum`, or the mapper performs a runtime check (`switch` /
`includes`) with an explicit fallback value.

#### Scenario: Status enum drift detection

- **GIVEN** the DB `status` column's allowed values and the TS
  `Session.status` union
- **WHEN** they diverge (a value is added on one side and not the other)
- **THEN** a unit test in `packages/core` fails with an error message that
  names the diverging value and the side it was added on

#### Scenario: Mapper rewrite

- **GIVEN** the legacy mapper at `apps/nextjs/src/app/actions/sessions.ts:74-99`
- **WHEN** the change is applied
- **THEN** the mapper is either deleted (when DB-derived `Session` covers all
  fields) or reduced to a `computeSessionRuntimeFields(row)` helper that
  returns only the `SessionRuntimeFields` slice, with no `as` casts
