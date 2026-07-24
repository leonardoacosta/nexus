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

- [ ] 2.1 Fresh-clone simulation: scratch worktree, `git clean -xdf`, `bun install --frozen-lockfile`, then `bunx turbo typecheck`, `bunx turbo lint`, `bun test` (PG via `docker compose -f docker-compose.test.yml up -d --wait`, `NEXUS_PG_TESTS=1`). Paste results. [type:testing] [beads:nx-ie266]
- [ ] 2.2 CI green end-to-end on the branch with pnpm fully removed; deploy/tests suite green after the recovery-branch removal. Paste run link + output. [type:testing] [beads:nx-vvtne]
