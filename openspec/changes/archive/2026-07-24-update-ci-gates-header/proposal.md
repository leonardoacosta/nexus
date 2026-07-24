---
order: 0724c
---

# Proposal: Update Stale CI Red-Gates Header; Ratchet Lint Warnings to Blocking

## Change ID
`update-ci-gates-header`

> Advisor stamp: 2026-07-24 `/improve` run against commit `9e4963b9`. Verify cited lines before starting; STOP on drift.

## Summary
`.github/workflows/ci.yml:8-19` carries a "PRE-EXISTING RED GATES" header documenting `pnpm typecheck` / `pnpm lint` / `pnpm lint:sql-safety` as red-at-base. All three were verified GREEN on 2026-07-24 (per-package `tsc --noEmit` clean incl. `@nexus/emit`; `apps/web` migrated off `next lint` to flat-config `eslint .` with 0 errors; sql-safety patterns 0 violations — the plans/006 guard landed). The stale header trains contributors to shrug at red runs. Replace it with a "gates are blocking" note and ratchet lint to `--max-warnings 0` so the now-green state can't silently erode.

## Context
- depends on:
- touches: `.github/workflows/ci.yml`, `apps/web/package.json`, `packages/core/package.json`, `packages/db/package.json`, `apps/nexus-emit/package.json`, `apps/nexus-statusline/package.json`, `apps/web/src/hooks/useMobileKeyboardBridge.ts`

## Motivation
Found by the 2026-07-24 advisor audit (DX category, HIGH confidence). The header's own closing line — "Maintainer action required: fix the pre-existing failures … so this gate becomes truly green-blocking" — is done; the documentation just never caught up. Warnings are currently non-blocking (`lint` scripts are bare `eslint .`), so the only remaining drift vector is warning accumulation.

## Testing
- CI run on the branch is green end-to-end with the ratchet applied.
- `grep -n 'PRE-EXISTING RED' .github/workflows/ci.yml` returns nothing.
- Per-package `eslint . --max-warnings 0` exits 0 locally (task 1.2 fixes the known warning at `apps/web/src/hooks/useMobileKeyboardBridge.ts:32` and any others enumerated by task 1.1's sweep).

## Done Means
- A contributor reading `ci.yml` sees that all gates are blocking and green — no stale red-gate caveats.
- A newly introduced lint warning fails CI instead of accumulating silently.
- Any package deliberately left un-ratcheted is named in the commit message with a reason.

## Scope
- **IN**: the ci.yml header block; per-workspace `lint` scripts gaining `--max-warnings 0`; fixing the existing warnings that sweep enumerates.
- **OUT**: the commented-out macOS Swift job (separate proposal `wire-macos-swift-ci`); new lint rules; turbo.json; the pnpm→bun install steps (separate proposal `converge-package-manager` — serialized via shared `ci.yml` touch).
