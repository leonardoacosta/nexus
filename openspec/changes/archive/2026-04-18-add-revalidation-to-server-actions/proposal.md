# Proposal: Add revalidatePath to Server Action mutations

## Change ID

`add-revalidation-to-server-actions`

## Summary

Add `revalidatePath` calls after each Server Action mutation in `apps/nextjs` so the RSC cache invalidates and the UI reflects fresh data without requiring a hard navigation. Closes the stale-cache gap introduced by Wave 3's HTTP-write rewire.

## Context

Extends `apps/nextjs/src/app/actions/settings.ts` and `apps/nextjs/src/app/actions/projects.ts`. These two files hold the only three Server Action mutations introduced by Wave 3:

- `updateProject` — PATCH `/projects/:id` via `AgentClient`
- `saveAgentConfig` (add branch) — POST `/agents` via `AgentClient`
- `saveAgentConfig` (remove branch) — DELETE `/agents/:name` via `AgentClient`

Related: the just-archived `2026-04-18-pick-db-writer-boundary` spec established that the dashboard must never write directly to the database and must delegate all mutations through the agent HTTP API. This proposal closes the cache-invalidation gap that delegation created.

## Motivation

When the dashboard wrote directly to the database, RSC cache invalidation was implicit — the DB write and the data fetch shared the same connection context. After Wave 3 rewired mutations through the agent HTTP API, that implicit signal disappeared. The cache now has no way to know that data has changed.

**Failure mode:** A user toggles agent config or edits a project tag, and the UI shows no change. The data is correct in the database, but the cached RSC output is stale. The user must perform a hard navigation (e.g., full page reload) to see their change. This will manifest as "I clicked save and nothing happened" bug reports the moment users start exercising the new write paths introduced by Wave 3.

**Root cause:** `revalidatePath` is the mechanism Next.js 15 App Router provides for Server Actions to signal RSC cache invalidation. It was never called because the original direct-DB writes didn't need it. The HTTP-write rewire did not add it.

Grep confirms zero `revalidatePath` or `revalidateTag` calls exist anywhere under `apps/nextjs/src/app/` today.

## Requirements

### Requirement: Cache revalidation on mutation

All Server Actions in `apps/nextjs/src/app/actions/` that perform mutations against the agent HTTP API MUST call `revalidatePath()` (or `revalidateTag()` if a tag-based scheme is later adopted) for every route that renders the mutated data, BEFORE returning to the caller.

Revalidation MUST only fire when the underlying mutation succeeds — failures must propagate to the caller without invalidating cache.

**Mutations and their affected routes:**

| Server Action | HTTP call | Routes to revalidate |
|---|---|---|
| `updateProject(id, data)` | PATCH `/projects/:id` | `/projects`, `/projects/[name]` |
| `saveAgentConfig("add", agent)` | POST `/agents` | `/settings` |
| `saveAgentConfig("remove", agent)` | DELETE `/agents/:name` | `/settings` |

Mutations that originate from outside the dashboard (e.g., agent-side cron jobs, peer-to-peer sync) are out of scope — they update via WebSocket or SSE channels not covered by Next.js cache.

## Scope

**In scope:**

- 3 mutations: `updateProject`, `saveAgentConfig` (add branch), `saveAgentConfig` (remove branch)
- 3 routes: `/projects`, `/projects/[name]`, `/settings`
- Verifying both affected pages use dynamic rendering so revalidation is not a no-op

**Out of scope:**

- Agent-side cache TTL refactor — covered by the separate `centralize-mutable-module-state` proposal (P2); the 5s TTL is small enough that stacking is rare in practice
- Migration to `revalidateTag`-based cache — PAGNI; the path-based approach is sufficient for the current route count
- SSE-driven UI updates — already implemented on the spec-events page; a different surface

## Impact

- **Files changed:** 2 (`apps/nextjs/src/app/actions/projects.ts`, `apps/nextjs/src/app/actions/settings.ts`)
- **Lines added:** ~6 (3 `revalidatePath` call sites plus their import if not already present)
- **Type changes:** none
- **Dependency additions:** none — `revalidatePath` ships with `next` (already a dependency)
- **API contract changes:** none — Server Actions return `void`, callers unaffected

## Risks

**Risk: revalidatePath called on a statically prerendered route → silent no-op.**

If `/projects` or `/settings` are statically prerendered at build time rather than dynamically rendered per-request, `revalidatePath` will appear to work (no error) but RSC output will not refresh until the next full deployment. This is the most dangerous failure mode because it produces no observable error.

Mitigation: task [1.3] explicitly requires verifying that both routes use dynamic rendering (`force-dynamic` or fetches wrapped in `unstable_noStore()`). If they are not, the page must be made dynamic as part of this change. Task [2.1–2.3] add unit tests that mock `revalidatePath` and assert it is called with the correct paths after success and not called on failure.

**Risk: Agent-side 5s TTL on `projectsCache` stacks on top — user saves → revalidate fires → next fetch hits agent within 5s → still stale.**

The Next.js cache will be invalidated correctly, but if the subsequent RSC re-render fetches project data from the agent within the 5s in-process TTL window, the agent returns the cached (pre-mutation) snapshot. The user sees the old data for up to 5 more seconds.

Mitigation: the TTL is small enough (5s) that most users will not notice. For true zero-staleness freshness, the future `centralize-mutable-module-state` spec will add a `clearProjectsCache()` hook that the Server Action can call post-mutation to purge the agent-side TTL immediately.
