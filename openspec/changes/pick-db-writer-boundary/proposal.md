# Change: pick-db-writer-boundary

## Summary

Eliminate dual database writers by making `apps/nextjs` a pure HTTP client of `apps/agent` for all writes (and reads where practical). Expose a narrowed `ReadOnlyDb` from `@nexus/db/readonly` for the residual nextjs read paths that stay direct, and enforce the boundary in the type system.

## Context

Audit findings C2-arch (error severity) and I3-arch (info) flagged that both `apps/nextjs` and `apps/agent` write to Postgres directly through `@nexus/db`, with no contract layer between them. Today 8 files in `apps/nextjs` import `@nexus/db`, several of which perform writes (`actions/sessions.ts`, `actions/projects.ts`, `actions/settings.ts`, `api/projects/route.ts`, `lib/projects.ts`, `lib/get-client.ts`). Meanwhile 63 files in `apps/agent` import `@nexus/db` legitimately as the canonical owner of ingest.

This proposal depends on the agent HTTP API being able to cover the dashboard's current write paths. It is mechanically independent of `split-core-browser-barrel` and `unify-session-credential-types`, but the type unification in `unify-session-credential-types` will make the agent-bound wire types easier to share, so prefer to land that first when sequencing.

## Motivation

- **Dual-write correctness hazard** — schema migrations break both apps simultaneously and require coordinated deploys; the agent's HTTP API and the dashboard's direct DB reads can return different views of the same row when timing differs.
- **No type-system enforcement** — `apps/agent/src/server-request-handler.ts:17` imports `Db` from `@nexus/db` and threads it through every handler. The dashboard could just as easily grab the full `Db` and start writing — there is no compile-time guard.
- **Contract drift** — every shared schema change risks two consumers in subtle disagreement, with no cross-app tests to catch it.

## Requirements

- `apps/nextjs` MUST NOT perform DB writes; all mutations originating from the dashboard MUST go through the agent HTTP API.
- `apps/nextjs` MAY perform DB reads ONLY via the `@nexus/db/readonly` subpath export.
- `@nexus/db` SHALL expose a narrowed `ReadOnlyDb` type via the `./readonly` subpath that omits `insert`, `update`, and `delete` methods.
- The agent HTTP API SHALL expose endpoints covering every current dashboard write path: sessions, projects, settings.
- An ESLint rule SHALL block imports of the full `Db` type from any file in `apps/nextjs/`.

## Scope

### In

- Migrate the 8 nextjs files that import `@nexus/db` to either HTTP calls (writes) or `ReadOnlyDb` (reads).
- Add the `ReadOnlyDb` export to `@nexus/db`.
- Add or verify agent endpoints for sessions, projects, and settings mutations.
- Add an ESLint rule + unit/E2E tests enforcing the boundary.

### Out

- Changing the agent's DB ownership (agent stays the writer).
- Refactoring database schemas.
- Auth changes — the agent HTTP API auth model is unchanged.
- Migrating `apps/agent` consumers (63 files) — they remain trusted writers.

## Impact

- **~70 files in scope** total; ~8 in `apps/nextjs` actively migrated, the rest verified untouched.
- **New endpoints in `apps/agent`** — sessions/projects/settings mutation surfaces.
- **New export in `packages/db`** — `./readonly` subpath + `ReadOnlyDb` type.
- **New ESLint rule** under the workspace ESLint config.
- **Mutation patterns in `apps/nextjs` change** — server actions become HTTP clients of the agent rather than direct drizzle callers.

## Risks

- **Performance regression from HTTP hop** — direct DB writes are sub-millisecond; an HTTP round-trip to the agent on the same Tailnet adds 10–50ms. Mitigation: measure baseline, accept the regression for correctness; if a specific endpoint hot path breaches a budget, fall back to a written-by-agent message-queue pattern rather than restoring direct DB access.
- **Missed write site** — a mutation snuck in via raw `db.execute()` or imported under an alias. Mitigation: ESLint rule blocks `Db` imports from `apps/nextjs`; CI fails on regression.
- **Endpoint surface gap** — agent doesn't yet expose every mutation needed. Mitigation: Task 2.1 audits the surface before any migration; gaps become tasks 2.2–2.4.
