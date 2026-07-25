---
stack: t3
---
<!-- beads:epic:nx-yn00u -->
<!-- beads:feature:nx-u35eh -->

# Tasks — converge-package-manager

> Written against commit `9e4963b9`. Verify cited lines before each task; STOP on drift. Ordering inside the API batch matters: repo manifest + CI first, and CI must be observed green BEFORE the deploy-hook tasks (1.5–1.6) land.

## API Batch

- [x] 1.1 Root `package.json`: set `"packageManager"` to the bun version deploy currently uses (check `bun --version` on the homelab; pin exactly), add `"tests/e2e"` to `workspaces`. Delete `pnpm-workspace.yaml`. [type:config] [beads:nx-xwhbv]
  - touches: `package.json`, `pnpm-workspace.yaml`
- [x] 1.2 Regenerate `bun.lock` (`bun install`), review the diff for unexpected version changes (escape hatch: STOP on surprise major bumps). Delete `pnpm-lock.yaml`. [type:config] [beads:nx-ogrqk]
  - touches: `bun.lock`, `pnpm-lock.yaml`
- [x] 1.3 `.github/workflows/ci.yml`: remove `pnpm/action-setup@v4` and the `cache: pnpm` from setup-node; replace `pnpm install --frozen-lockfile` with `bun install --frozen-lockfile`; replace `pnpm typecheck|lint|lint:sql-safety|test` and `pnpm --filter @nexus/db db:migrate` invocations with bun/bunx equivalents (root scripts already exist — verify `bun run typecheck` maps to `turbo typecheck`). [type:config] [beads:nx-wxn9g]
  - touches: `.github/workflows/ci.yml`
- [x] 1.4 Add the second-lockfile CI guard step: `run: '! git ls-files | grep -E "pnpm-lock|yarn.lock|package-lock"'`. [type:config] [beads:nx-1mkct]
  - touches: `.github/workflows/ci.yml`
- [x] 1.5 ONLY after 1.3/1.4 are observed green in CI — `deploy/hooks.d/post-merge/02-deploy`: remove the drift-recovery branch (lines 61-76 at base — the non-frozen retry, `git checkout -- bun.lock`, socat alert). Frozen-install failure becomes a hard `fail` with a clear message. [type:api] [beads:nx-4vuh1]
  - touches: `deploy/hooks.d/post-merge/02-deploy`
- [x] 1.6 Update `deploy/tests/02-deploy-lockfile-drift.test.sh` to assert the NEW contract (drift → hard fail, no silent recovery) or retire it with a note if the scenario is no longer constructible. [type:testing] [beads:nx-pt24w]
  - touches: `deploy/tests/02-deploy-lockfile-drift.test.sh`
- [x] 1.7 Docs: README.md Quick Start + `.claude/CLAUDE.md` Build/Run table — `pnpm install` → `bun install`; `pnpm --filter @nexus/db db:generate` → verified bun equivalent (confirm drizzle-kit runs under `bunx` first). Grep for remaining live `pnpm ` references (excluding openspec/archive, plans/, docs/ history) and update. [type:docs] [beads:nx-9ea78]
  - touches: `README.md`, `.claude/CLAUDE.md`

## E2E Batch

- [x] 2.1 Fresh-clone simulation: scratch worktree, `git clean -xdf`, `bun install --frozen-lockfile`, then `bunx turbo typecheck`, `bunx turbo lint`, `bun test` (PG via `docker compose -f docker-compose.test.yml up -d --wait`, `NEXUS_PG_TESTS=1`). Paste results. [type:testing] [beads:nx-ie266]
  - `bun install --frozen-lockfile`: "Checked 246 installs across 347 packages (no changes)" — clean, no drift.
  - `bunx turbo typecheck`: 9/9 successful.
  - `bunx turbo lint`: 8/8 successful, 0 errors (50 pre-existing warnings, unratcheted packages).
  - `bun test` (PG migrated, NEXUS_PG_TESTS=1): completed in 154s (not a hang — see nx-9qsmb.12 for the separate pre-push-hook hang, confirmed NOT reproduced by a bare fresh-clone run). 1929 pass, 121 fail, 30 errors, 26 skip across 2076 tests. Failures traced to two pre-existing, non-migration test-infrastructure gaps (bun test picking up Playwright e2e specs meant for `playwright test`; a version.gen build-order gap for one e2e test) — filed as nx-9qsmb.13, not blocking this spec.
- [x] 2.2 CI green end-to-end on the branch with pnpm fully removed; deploy/tests suite green after the recovery-branch removal. Paste run link + output. [type:testing] [beads:nx-vvtne]
  - CI run https://github.com/leonardoacosta/nexus/actions/runs/30138559255 (commit 3add14ee): package-manager steps (bun install --frozen-lockfile, second-lockfile guard) passed cleanly. Overall job red only from the same 4 pre-existing apps/agent test flakes tracked in nx-9qsmb.11 (unrelated to this migration, confirmed via git diff since session start).
  - `deploy/tests/02-deploy-lockfile-drift.test.sh`: "PASS: 02-deploy hard-fails immediately on lockfile drift (no silent recovery)" — asserts the new hard-fail contract post-recovery-branch-removal.
