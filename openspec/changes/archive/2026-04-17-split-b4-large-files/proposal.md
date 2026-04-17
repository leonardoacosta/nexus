# Proposal: Split B4 Large Files

## Change ID
`split-b4-large-files`

## Summary
Split the 6 production files flagged by audit-scan's B4 rule (>500 lines) into focused modules behind barrel re-exports. Preserve every existing public import path so consumers don't need to update; only internal structure changes. Drop the B4 suppression entries from `.audit-suppressions.json` after the splits land, and update the integration-test baseline to assert B4 count is 0. This closes the final audit-debt bead (nx-iwu3) and leaves the nx project queue genuinely clean.

## Context
- Extends: 6 large production files:
  - `apps/agent/src/credentials/pool.ts` (1083 lines) — credential pool manager
  - `apps/agent/src/server.ts` (786 lines) — HTTP + WebSocket agent server
  - `apps/agent/src/routes.ts` (694 lines) — route registry + dispatcher
  - `apps/agent/src/routes/credentials.ts` (638 lines) — credentials HTTP handlers
  - `apps/agent/src/services/socket-server.ts` (521 lines) — Unix-socket CLI server
  - `apps/nextjs/src/components/CredentialsTable.tsx` (525 lines) — credentials UI
- Related archives: `2026-04-16-fix-audit-real-debt` (filed nx-iwu3 as follow-up), `2026-04-17-cleanup-residual-debt` (established today's cleanup pattern)
- Related bead (closed by this spec): `nx-iwu3` (B4 production-file splits spec candidate)
- Current audit state: composite 99/A, 6 findings (5 info-level + B4 suppressed); after this spec B4 suppression disappears and the rule genuinely reports 0.

## Motivation

The 6 files all work today, have adequate test coverage, and show no observed bugs. B4 is not a correctness gate — it's a maintainability signal. At 1083 lines, `pool.ts` has become hard to navigate in isolation; at 694 lines, `routes.ts` is a switch-like orchestrator that has grown past what a single file can readably express. Splitting them into focused modules:

1. **Reduces cognitive overhead for review**: new contributors (or agents) reading `pool.ts` today face 1083 lines of mixed concerns. After the split, each module tells one story (state, lease/release, rotation, probe).
2. **Makes future refactors cheaper**: when a focused module needs to change, reviewers don't need to scroll past unrelated logic.
3. **Closes the final audit-debt bead (nx-iwu3)**: takes the bead queue from "one big tracked refactor deferred" to zero audit-debt items.
4. **Removes the need for B4 suppression entries** that currently mask a real quality signal.

The work is strictly mechanical: extract cohesive chunks into sibling files under a subdirectory, keep the original path as a barrel re-export, update internal imports only where needed, and run the existing test suite as the acceptance gate. No public contract changes.

## Requirements

### Requirement: Each split preserves the public import path
The existing file path (e.g., `apps/agent/src/credentials/pool.ts`) SHALL continue to be a valid import target after the split. Callers importing `@nexus/agent/credentials/pool` or using the relative path SHALL NOT need to change their imports. The original file SHALL become a barrel re-export of the new subdirectory's `index.ts`.

### Requirement: Each split produces modules under 500 lines
After splitting, no file in the new subdirectory SHALL exceed 500 lines. The split boundaries SHALL follow natural concern boundaries (e.g., types, errors, state, operations) rather than arbitrary line counts.

### Requirement: credentials/pool.ts split
`apps/agent/src/credentials/pool.ts` SHALL be reorganized into `apps/agent/src/credentials/pool/` with at minimum these modules:
- `types.ts` — `CredentialListEntry`, `CredentialPromoteResult`, `ManualSwapResult`, `CredentialDuplicateEntry` type exports
- `errors.ts` — `CredentialDeleteError` class
- `pool.ts` — `CredentialPool` class core (state, lease, release)
- `rotation.ts` OR other concern modules — whatever cohesive chunks naturally extract
- `index.ts` — barrel re-export matching current public surface

The original `pool.ts` SHALL remain as a barrel (e.g., `export * from "./pool/index"`) to preserve callers.

### Requirement: server.ts split
`apps/agent/src/server.ts` SHALL be reorganized into a module structure that preserves the `ServerState`, `healthCollector`, `streamManager`, and `startServer` exports. Candidate extractions: health-ingest handler, origin-check middleware (already added in cleanup-residual-debt), startup logging + server teardown. The `startServer` function SHALL remain at its current import path.

### Requirement: routes.ts split
`apps/agent/src/routes.ts` SHALL be reorganized so that route-definition logic is distributed into domain-specific files under `apps/agent/src/routes/` (several already exist: `credentials.ts`, `projects-discovered.ts`, etc.). The `buildRoutes` function SHALL remain the public orchestrator but delegate to per-domain builders. The file `apps/agent/src/routes.ts` MAY be renamed to `apps/agent/src/routes/index.ts` if that simplifies the structure, as long as the import `"./routes"` still resolves.

### Requirement: routes/credentials.ts split
`apps/agent/src/routes/credentials.ts` SHALL be reorganized into `apps/agent/src/routes/credentials/` with handlers grouped by concern (CRUD vs lease/release vs promote/rate-limit). All 13 current exports SHALL continue to be importable from `apps/agent/src/routes/credentials` (barrel re-export).

### Requirement: services/socket-server.ts split
`apps/agent/src/services/socket-server.ts` SHALL be reorganized into `apps/agent/src/services/socket-server/` with modules for types, dispatcher, and server lifecycle. All 9 current exports SHALL continue to be importable from `apps/agent/src/services/socket-server`.

### Requirement: CredentialsTable.tsx split
`apps/nextjs/src/components/CredentialsTable.tsx` SHALL be reorganized into `apps/nextjs/src/components/credentials-table/` with sibling components for row / action cluster / status cell / filter UI (whatever naturally decomposes). The main `CredentialsTable` component SHALL remain importable from `apps/nextjs/src/components/CredentialsTable` (barrel re-export).

### Requirement: No behavior change
All existing tests SHALL pass unchanged against the split modules. If a test file imports from an internal path that didn't exist before the split (e.g., `credentials/pool/rotation`), that's acceptable — but no test SHALL be modified to paper over a behavior regression.

### Requirement: B4 suppression entries retired
After all splits land and tests pass, the B4 entry in `.audit-suppressions.json` covering the 6 production files SHALL be removed. The `autoSkipTestFiles` entry for B4 SHALL be preserved (test files can still be large).

### Requirement: Audit baseline updated
The integration test `packages/core/src/audit-suppressions.integration.test.ts` SHALL be updated with an assertion that B4 count is 0 after the splits and suppression removal. Composite score SHALL hold at ≥ 99.

## Scope

- **IN**: 6-file split per the per-file requirements above, barrel re-exports preserving public paths, B4 suppression entry removal, integration-test baseline update, verification that all existing tests pass unchanged
- **OUT**: Behavior changes (none allowed), performance optimizations, rewrites of the logic within the extracted modules, any cross-cutting API redesign, extracting to new packages, reorganizing the apps/ vs packages/ split

## Impact

| Area | Change |
|------|--------|
| `apps/agent/src/credentials/pool.ts` | Becomes barrel re-exporting new `pool/` subdir; actual code split into ~4-5 cohesive modules |
| `apps/agent/src/credentials/pool/` (new dir) | Contains types, errors, core class, rotation, promote — each under 500 lines |
| `apps/agent/src/server.ts` | Extracts into helper modules (health-ingest, origin-check, startup sequencing) |
| `apps/agent/src/routes.ts` | Reorganized — `buildRoutes` delegates to per-domain builders under `routes/` |
| `apps/agent/src/routes/credentials.ts` | Becomes barrel over `routes/credentials/` subdir with concern-grouped handlers |
| `apps/agent/src/services/socket-server.ts` | Becomes barrel over `services/socket-server/` subdir |
| `apps/nextjs/src/components/CredentialsTable.tsx` | Becomes barrel over `credentials-table/` subdir with sibling components |
| `.audit-suppressions.json` | Remove B4 entry covering the 6 production paths |
| `packages/core/src/audit-suppressions.integration.test.ts` | Add/update B4=0 baseline assertion |
| Public import paths | UNCHANGED for every file — consumers need no changes |

## Risks

| Risk | Mitigation |
|------|-----------|
| A barrel re-export misses a symbol (missing `export *` line) — callers fail at build/typecheck | After each split, run `pnpm --filter @nexus/agent typecheck` (and `@nexus/nextjs`) BEFORE moving to the next file. Typecheck catches missing re-exports immediately |
| Circular imports introduced by naive split (module A imports from module B which imports from A) | Plan the split so each module's imports flow in one direction (types → core → operations → orchestrator). Follow the dependency hierarchy that naturally exists |
| Test file import paths break if tests reach into the original file's internals | Check test files for imports from the target files before splitting; if a test uses internal symbols not in the public barrel, either add them to the barrel or update the test import to the new path |
| `routes.ts` split conflicts with already-extracted `routes/*` files | The existing `routes/credentials.ts`, `routes/projects-discovered.ts`, etc. are the natural home for the corresponding definitions in `routes.ts`. Move dispatch logic into them; `routes.ts` becomes a thin orchestrator or moves to `routes/index.ts` |
| Session fatigue — late-day refactor introduces subtle bugs | Work one file at a time, test-gate between each. If a split breaks tests, STOP and revert that file — don't proceed to the next. The spec's tasks.md structure enforces this |
| Reviewer burden — 30+ files changed in one PR | The change is mechanical (moves + re-exports) with behavior preserved, which reviewers can scan quickly. Each split commit should be self-contained so review can proceed file-by-file |
| `CredentialsTable.tsx` split may need CSS/style co-location adjustments | React component splits often expose shared styles as an afterthought. If the original file has inline styles or CSS modules, preserve them via shared module or duplicate — don't introduce new style coupling patterns mid-refactor |

## Open Questions

- **`routes.ts` rename** — should `apps/agent/src/routes.ts` become `apps/agent/src/routes/index.ts`? It's cleaner but changes what the directory structure implies. Default: keep `routes.ts` as a thin file importing from `routes/index.ts` or individual domain files, to minimize diff surface.
- **Lazy-loaded components in CredentialsTable** — if the current file uses `dynamic()` or lazy-loaded children, the split must preserve that boundary. Agent investigating this task should check before splitting.
- **Shared internal state between extracted modules** — if `pool.ts` has module-level singletons (caches, maps), those become shared state across the split. Either move them to a dedicated `state.ts` module or pass them explicitly. Default: explicit passing unless it creates unreasonable API churn.
