# Proposal: Fix TypeScript Project References

## Change ID
`fix-tsconfig-project-refs`

## Summary
Introduce TypeScript project references across all workspace packages so the language server resolves each package in isolation, eliminating the LSP diagnostic flood caused by the root `tsconfig.json` owning all files with an invalid `rootDir`.

## Context
- Extends: `tsconfig.json` (root), `packages/core/tsconfig.json`, `packages/db/tsconfig.json`, `packages/ui/tsconfig.json`, `apps/agent/tsconfig.json`, `apps/nextjs/tsconfig.json`, `apps/nexus-register/tsconfig.json`
- Related: archived `fix-ts-agent-quality` (2026-04-04) — that spec migrated tests to vitest; this spec fixes the upstream config that was causing stale type errors throughout

## Motivation
The root `tsconfig.json` sets `rootDir: "src"` but `/src` does not exist at the workspace root. Because no TypeScript project references are configured, tsserver loads the root tsconfig as the single program root for all files. This causes three failure modes:

1. **`packages/core` errors** — files are flagged as "not under rootDir `/home/nyaptor/dev/nx/src`" even though each package sets its own `rootDir: "src"` that should resolve relative to the package.
2. **`apps/nextjs` errors** — `next`, `geist`, and `react` cannot be resolved because they live in `apps/nextjs/node_modules/`, not the workspace root that the root tsconfig resolves from.
3. **Stale agent `db/*.ts` errors** — the root tsconfig produces a stale program state that persists across edits because there is no per-package `tsbuildinfo`.

The fix is the canonical TypeScript monorepo pattern: extract shared compiler options into `tsconfig.base.json`, make each package `composite`, and wire the root `tsconfig.json` to hold only `references`.

## Requirements

### Req-1: Shared base config extracted
A `tsconfig.base.json` at the workspace root holds all shared `compilerOptions` with no `rootDir`, `outDir`, `include`, or `exclude` fields.

### Req-2: Root tsconfig becomes references-only
The root `tsconfig.json` contains only `"files": []` and a `references` array pointing to every TypeScript package. This prevents tsserver from accidentally owning workspace-wide files.

### Req-3: Each package is composite
All six TypeScript packages (`packages/core`, `packages/db`, `packages/ui`, `apps/agent`, `apps/nextjs`, `apps/nexus-register`) extend `tsconfig.base.json` (not `tsconfig.json`) and add `composite: true`. Existing `rootDir`, `outDir`, `include`, and `exclude` values are preserved.

### Req-4: LSP errors resolve
After the change, `pnpm typecheck` passes with zero errors and the language server reports no false-positive diagnostics in `packages/core`, `apps/agent/src/db/`, or `apps/nextjs/src/app/`.

## Scope
- **IN**: `tsconfig.json` (root), new `tsconfig.base.json`, all six package-level tsconfigs
- **OUT**: Runtime behavior, build output, test configuration, `packages/watcher` (Rust-only, no tsconfig), ESLint config

## Impact
| Area | Change |
|------|--------|
| Root tsconfig | Becomes references-only aggregator (`files: []` + `references`) |
| `tsconfig.base.json` | New file — shared compiler options without rootDir/outDir |
| 6 package tsconfigs | `extends` path updated; `composite: true` added |
| LSP | Per-package isolation; stale diagnostics cleared |
| Build | Incremental per-package `tsbuildinfo`; `tsc --build` now valid |
| CI | `pnpm typecheck` continues to work via Turbo; `tsc -b` also valid |

## Risks
| Risk | Mitigation |
|------|-----------|
| `tsc --build` first run slower (builds all packages from scratch) | One-time cost; subsequent builds incremental |
| `apps/nextjs` uses `noEmit: true` — `composite` requires `declaration` | Set `declarationDir` in nextjs tsconfig or override `declaration: false` with `noEmit: true` (noEmit suppresses the requirement in TS 5.x) |
| Package `paths` may need updating if cross-package imports relied on root resolution | Verify with `pnpm typecheck` post-change |
