# Proposal: Layering Enforcement & DRY Cleanup

## Change ID
`enforce-layering-dry-cleanup`

## Summary
Fix UI layering violations, extract duplicated project-mapping logic into a shared helper, hoist the TtlCache to module scope to survive across serverless invocations, and replace magic fallback literals with named constants.

## Context
- Extends: `apps/nextjs/src/lib/db.ts`, `apps/nextjs/src/lib/get-client.ts`, `apps/nextjs/src/app/actions/projects.ts`, `apps/nextjs/src/app/actions/settings.ts`, `apps/nextjs/src/app/api/projects/route.ts`, `packages/db/src/index.ts`
- Related: code audit findings (P2); no prior specs touch these files

## Motivation
A code audit surfaced four hygiene issues in `apps/nextjs/`:

1. **Layering violations** -- Several files import internal `@nexus/db` paths (e.g. `"@nexus/db"` for both schema tables and operators like `eq`) which works today but couples the Next.js app to `@nexus/db` internals. More critically, `get-client.ts` imports `agents` and `eq` directly from `@nexus/db` instead of using the barrel. The current barrel already re-exports tables and operators, so the fix is to ensure all consumers use the public API consistently.
2. **DRY violation** -- `fetchProjects()`, `fetchProject()`, and `GET /api/projects` each duplicate the same 20-field select + row-to-ProjectLocation mapping. Any schema change must be updated in 3 places.
3. **Defeated TtlCache** -- `getClient()` creates a fresh `AgentClient` (with a fresh `TtlCache`) on every call. In serverless, each request gets a new module scope anyway, but even in the dev server the cache is thrown away. Hoisting the cache to module level lets it actually work as intended.
4. **Magic literal** -- `priority: row.priority ?? 999` appears 3 times with no explanation of what 999 means.

## Requirements

### Req-1: Route all DB access through @nexus/db barrel
All `apps/nextjs/` files must import tables and operators exclusively from `@nexus/db` (the barrel at `packages/db/src/index.ts`). No imports from internal `@nexus/db` sub-paths.

### Req-2: Extract shared buildCanonicalProject helper
A single `buildCanonicalProject()` function (and supporting `PROJECT_SELECT_FIELDS` constant) must be the only place that maps join rows to `CanonicalProject`. Used by `fetchProjects()`, `fetchProject()`, and `GET /api/projects`.

### Req-3: Hoist TtlCache to module scope
The `TtlCache` instance used by `AgentClient` must live at module level in `get-client.ts` so it persists across `getClient()` calls within the same process. `AgentClient` constructor accepts an optional cache parameter.

### Req-4: Replace magic fallback with named constant
Introduce `DEFAULT_PRIORITY = 999` in `@nexus/core` (or a local constants file) and use it in all locations that currently hard-code `999`.

## Scope
- **IN**: `apps/nextjs/src/lib/db.ts`, `apps/nextjs/src/lib/get-client.ts`, `apps/nextjs/src/app/actions/projects.ts`, `apps/nextjs/src/app/actions/settings.ts`, `apps/nextjs/src/app/api/projects/route.ts`, `apps/nextjs/src/lib/agent-client.ts`, `packages/db/src/index.ts`
- **OUT**: Rust crates, Bun agent, TUI, schema migrations, new DB columns, test files (existing tests should pass without changes)

## Impact
| Area | Change |
|------|--------|
| `packages/db/src/index.ts` | Verify barrel exports cover all needed tables/operators (already does) |
| `apps/nextjs/src/lib/get-client.ts` | Fix imports; hoist cache to module level |
| `apps/nextjs/src/app/actions/projects.ts` | Extract `buildCanonicalProject()`; use named constant |
| `apps/nextjs/src/app/api/projects/route.ts` | Use shared helper instead of inline mapping |
| `apps/nextjs/src/app/actions/settings.ts` | Fix imports to use barrel only |
| `apps/nextjs/src/lib/agent-client.ts` | Accept optional external cache in constructor |

## Risks
| Risk | Mitigation |
|------|-----------|
| Barrel re-exports miss a symbol | Audit all imports before changing; `@nexus/db` already exports all tables and common operators |
| Module-level cache leaks state between unrelated requests | TtlCache already has TTL-based expiry; serverless cold starts reset module scope naturally |
| Shared helper introduces import cycle | Helper lives in `apps/nextjs/src/lib/projects.ts` -- leaf module, no cycles possible |
