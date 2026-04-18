# Proposal: Unify Session and Credential Types

## Change ID

unify-session-credential-types

## Summary

Make `@nexus/db` Drizzle `$inferSelect` types the single source of truth for the
`Session` and credential row shapes. Derive the domain `Session` interface in
`@nexus/core` from the DB row via `Pick`/`Omit` and intersect with a small
`SessionRuntimeFields` type for runtime-only computed fields
(`lastHeartbeat`, `command`, `agent`, `rateLimitType`). Relocate the
hand-written `WireCredentialRow` interface from
`apps/nextjs/src/app/actions/credentials.ts:16` into
`packages/core/src/types/account.ts` so wire shapes are owned by `@nexus/core`.
Delete the bespoke mapper at `apps/nextjs/src/app/actions/sessions.ts:74-99` —
or reduce it to a thin "compute runtime fields from DB row" helper — and remove
the silent `as Session["status"]` / `as Session["sessionType"]` casts that
currently hide enum drift.

## Context

This proposal addresses architecture audit finding **C1-arch (type ownership
drift)** and **B10 (wire-type misplacement)** from the 2026-04-08 Wave 3 audit.

**Sequencing dependency:** This change assumes `split-core-browser-barrel`
(which decouples the `@nexus/core` browser-safe surface from the agent-side
imports) lands first. Without that change, importing DB-derived types into
`@nexus/core` risks pulling Drizzle / `pg` modules into the Next.js client
bundle. Once `split-core-browser-barrel` is archived, this proposal can be
applied safely because the type-level `$inferSelect` import is erased at
compile time and never reaches the runtime browser bundle.

The repo is a TypeScript monorepo (`apps/nextjs`, `apps/agent` Bun,
`packages/core`, `packages/db`). It is not the Rust workspace described in
some legacy specs.

## Motivation

Today `Session` is declared independently in three places:

1. `packages/db/src/schema/sessions.ts` — Drizzle schema (`lastActivity`,
   `idleSince`, `rateLimitResetAt`, no enum constraint on `status`).
2. `packages/core/src/types/session.ts:10` — JSON-friendly domain interface
   (`lastHeartbeat`, `command`, `agent`, `rateLimitType`, narrow `status`
   union).
3. `apps/nextjs/src/app/actions/sessions.ts:74-99` — a hand-written mapper
   bridges (1) → (2) and uses two `as Session["status"]` casts plus an
   `as Session["sessionType"]` cast to silence the enum gap.

Adding a single column to `sessionsTable` requires touching five places —
schema, migration, domain type, mapper, every consumer — with **no compiler
help** when any one of them drifts. The `as` casts in the mapper actively
suppress the only signal TypeScript could give us.

The same problem applies to credentials: `WireCredentialRow` is declared in
the Next.js action layer (`apps/nextjs/src/app/actions/credentials.ts:16`)
even though it is a wire-protocol superset of `CredentialFile` from
`@nexus/core`. The wire shape belongs next to the domain type it widens, not
in a server action.

Deriving the domain `Session` from the DB row eliminates the drift entirely:
`tsc` will fail closed when a column is added or an enum value diverges.

## Requirements

### Requirement: Single source of truth for entity shapes

The Drizzle schema in `@nexus/db` MUST be the single source of truth for
entity shapes. Domain types in `@nexus/core` (e.g. `Session`,
`CredentialFile`) MUST be derived from `$inferSelect` / `$inferInsert` via
`Pick` / `Omit`, never declared independently.

### Requirement: Computed runtime fields are intersected, not inlined

Runtime-only fields that are not stored in the DB (e.g. `lastHeartbeat`,
`command`, `agent`, `rateLimitType`) MUST live on a separate type
(`SessionRuntimeFields`) that is intersected with the DB-derived base. They
MUST NOT be added to the domain `Session` interface inline, because that
would break the "DB row is the base" invariant.

### Requirement: Wire shapes live in @nexus/core

Wire-protocol row interfaces returned by the Bun agent (e.g.
`WireCredentialRow`) MUST be declared in `packages/core/src/types/`, not in
the Next.js action layer. Action files MUST import them from `@nexus/core`.

### Requirement: No silent type casts in shape mappers

Mapper code that converts a DB row into a domain type MUST NOT use `as`
assertions to coerce string columns into TS string-literal unions
(e.g. `as Session["status"]`). Either the column is typed as the union at the
schema level (preferred), or the mapper performs a runtime check with an
explicit fallback.

## Scope

### In scope

- `Session` interface in `packages/core/src/types/session.ts` — refactor to
  derive from `@nexus/db` row.
- `SessionRuntimeFields` — new type for computed UI/transport fields.
- `WireCredentialRow` — move from
  `apps/nextjs/src/app/actions/credentials.ts:16` to
  `packages/core/src/types/account.ts`.
- Mapper at `apps/nextjs/src/app/actions/sessions.ts:74-99` — delete or
  reduce to a `computeSessionRuntimeFields(row)` helper, remove `as` casts.
- All ~30 consumer sites importing `Session` from `@nexus/core`.

### Out of scope

- Credential rotation / pool-leasing logic.
- Schema migrations or column additions to `sessionsTable` /
  `credentialsTable`.
- UI prop changes — components keep their existing `Session` import
  signature; the only behavioural change is that `tsc` now sees the DB
  shape.

## Impact

- **Affected packages:** `packages/core` (type rewrite), `packages/db`
  (no source change, but consumers now depend on its inferred types),
  `apps/nextjs` (mapper deletion + ~30 import sites), `apps/agent` (any
  consumer of `Session` from `@nexus/core` re-typechecks).
- **Estimated touch surface:** ~30 files importing `Session` from
  `@nexus/core` plus 2 action files (`sessions.ts`, `credentials.ts`).
- **Runtime behaviour:** No runtime change expected — this is a compile-time
  refactor. The mapper rewrite preserves existing field values 1:1.
- **Bundle size:** No impact (types are erased).

## Risks

- **Enum widening:** The DB stores `status` as `text` with no check
  constraint, while the TS union is narrow (`"active" | "idle" | "ended" |
  "stale" | "errored"`). Deriving `Session.status` from the DB row would
  widen it to `string` and break consumers. **Mitigation:** keep `status`
  and `sessionType` as overrides in `SessionRuntimeFields` (or a `Pick`
  exclusion list) until a follow-up change adds a Drizzle `enum()` column.
- **Status semantic drift:** A DB enum value that does not exist in the TS
  union (or vice versa) currently produces no error. **Mitigation:** unit
  test that compares the DB `status` enum (or, until enum is added, the set
  of values asserted by the mapper's fallback) against the TS union
  membership and fails on divergence.
- **Date vs string serialization:** `Session` currently types timestamps as
  `Date`, while the wire format is ISO string. The DB `$inferSelect` returns
  `Date` (mode: `"date"`), so domain stays `Date`-typed; the JSON boundary
  in server actions already serializes correctly. No change needed, but the
  audit should verify no client component receives a raw `Date` post-RSC
  serialization.
- **Sequencing:** Applying before `split-core-browser-barrel` lands risks
  pulling Drizzle's runtime into the client bundle if a non-type import
  slips in. **Mitigation:** all new imports from `@nexus/db` into
  `@nexus/core` MUST use `import type` syntax; add an ESLint rule or
  build-time check.
