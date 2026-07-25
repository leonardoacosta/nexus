---
order: 0724b
---

# Proposal: Converge on a Single Package Manager (Kill the Dual-Lockfile Split-Brain)

## Change ID
`converge-package-manager`

> Advisor stamp: authored by the 2026-07-24 `/improve` advisor run against commit `9e4963b9`. Verify cited excerpts before starting; STOP on drift.

## Context
- depends on: `update-ci-gates-header`
- touches: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `bun.lock`, `.github/workflows/ci.yml`, `deploy/hooks.d/post-merge/02-deploy`, `deploy/tests/02-deploy-lockfile-drift.test.sh`, `README.md`, `.claude/CLAUDE.md`

## Summary
The repo carries two lockfiles resolved by two different package managers, validated by two different pipelines: CI installs with `pnpm install --frozen-lockfile` against `pnpm-lock.yaml` (`.github/workflows/ci.yml:50`), while production deploys install with `bun install --frozen-lockfile` against `bun.lock` (`deploy/hooks.d/post-merge/02-deploy:60`). A green CI therefore does not prove a reproducible production install. The drift is not hypothetical: the deploy hook contains a full auto-recovery branch (non-frozen `bun install` + `git checkout -- bun.lock` + a socat alert ending "regenerate and commit bun.lock upstream to stop this recurring", 02-deploy:61-76) and a dedicated regression test (`deploy/tests/02-deploy-lockfile-drift.test.sh`) that exist *only because* this recurs (bead nx-zpbqi). Converge on **bun** as the single manager, delete `pnpm-lock.yaml`, and retire the recovery bandage.

## Current state (verified at `9e4963b9`)
- Root `package.json`: `"packageManager": "pnpm@9.15.0"` AND a `workspaces` array (read by bun); `pnpm-workspace.yaml` additionally lists `tests/e2e`, which the `workspaces` array does NOT include — the two workspace definitions are already out of sync.
- `pnpm-lock.yaml` (last touched Jul 17) and `bun.lock` (Jul 19) both tracked.
- CI (`ci.yml:44-50`): `pnpm/action-setup@v4` + `setup-node` with pnpm cache + `oven-sh/setup-bun@v2` — both toolchains already installed in CI.
- Deploy: bun-only, with the drift-recovery branch quoted above.
- Runtime is Bun everywhere (CLAUDE.md convention: "Bun for TS/JS code paths; never tsc for execution"); `bun test` is the test runner; agent binary is `bun build --compile`.

## Decision
Converge on **bun**: the runtime, test runner, build tool, and production installer are already bun — pnpm exists only for dev-install and CI-install. The alternative (converge on pnpm, make deploy `pnpm install`) would put a second toolchain on the homelab deploy path where bun is already required for the runtime, and keep the `packageManager`-vs-reality split. Trade-off accepted: losing pnpm's stricter node_modules isolation; turbo is manager-agnostic and keeps working.

Escape hatches (STOP and report back if hit):
- If `bun install` at the root fails to resolve `tests/e2e` after adding it to the `workspaces` array, or produces a node_modules layout that breaks `turbo`/`next build`, stop — do not paper over with per-package installs.
- If any workflow or script greps for `pnpm-lock.yaml` beyond those listed in Scope, stop and enumerate before deleting.

## Testing
- Fresh-clone simulation: `git clean -xdf` in a scratch worktree → `bun install --frozen-lockfile` succeeds → `pnpm typecheck`-equivalent (`bunx turbo typecheck`), `bunx turbo lint`, `bun test` (with `docker-compose.test.yml` PG up, `NEXUS_PG_TESTS=1`) all green.
- CI run on a branch must pass end-to-end with the pnpm steps removed.
- Deploy dry-run: `deploy/tests/` suite green after the recovery-branch removal (update `02-deploy-lockfile-drift.test.sh` — see tasks).

## Done Means
- Mechanical: CI green with a single `bun install --frozen-lockfile`; `git ls-files | grep pnpm` returns nothing.
- Behavior: dependency changes require exactly one lockfile update; a frozen deploy install can no longer drift from what CI validated.
- Done-when: `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the `packageManager: pnpm` pin, and the deploy auto-recovery branch are gone; docs/scripts reference bun only.

## Scope
- **IN**: root `package.json` (`packageManager` → bun, `workspaces` gains `tests/e2e`), delete `pnpm-lock.yaml` + `pnpm-workspace.yaml`, `ci.yml` install steps (drop `pnpm/action-setup`, drop pnpm cache, replace `pnpm …` script invocations with `bunx turbo …` / `bun …` equivalents), deploy hook recovery-branch removal (02-deploy:61-76) + its drift test update, README/CLAUDE.md command tables (`pnpm install` → `bun install`, `pnpm --filter @nexus/db db:generate` → bun equivalent — verify drizzle-kit runs under `bunx` first).
- **OUT**: any dependency version changes (lockfile regeneration must be resolution-neutral where possible — review the bun.lock diff for surprise major bumps and STOP if any appear); turbo config semantics; the `db:push` prohibition (unchanged); Swift toolchain.

## Maintenance note
After this lands, the socat drift alert can never fire again; if a future contributor reintroduces a second lockfile, CI should fail — add a one-line guard step (`! git ls-files | grep -E 'pnpm-lock|yarn.lock|package-lock'`) to the workflow as part of this change.
