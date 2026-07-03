# Plan 013: Add a neutral GitHub Actions CI workflow that runs the existing quality gates on every push/PR

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 64a206ff..HEAD -- package.json turbo.json docker-compose.test.yml packages/db/package.json apps/agent/package.json scripts/lint-sql-safety.sh apps/agent/src/testing/live-pg.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/006-green-sql-safety-guard.md (the `lint:sql-safety` gate must already be green — a red guard would make this workflow fail on its first run)
- **Category**: dx
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

There is no `.github/` directory in this repo (`ls -la .github` → absent). Every
quality gate lives in the git hook `deploy/hooks.d/pre-push/01-deploy`, which
only fires on push-to-`main`, only for contributors who installed the hook, and
is bypassable with `SKIP_DEPLOY=1 git push`. `docker-compose.test.yml` even
documents an intended "GitHub Actions step" in its header comment, but no
workflow consumes it. The result: correctness depends on each contributor's OS
and hook state — Swift tests silently skip off-Mac, PG-backed tests only run if
someone remembered the env flags, and a hookless or bypassed push has zero gate.
There is no reproducible "is main green?" signal. This plan adds one neutral
Linux CI job that runs the *existing* commands (`typecheck`, `lint`,
`lint:sql-safety`, `test`) against a throwaway Postgres, so the gate no longer
depends on any individual machine.

## Current state

Relevant files (all read during recon, excerpts below):

- `package.json` — root scripts. The CI reuses these verbatim; do NOT invent new
  scripts:
  ```json
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "lint": "turbo lint",
    "typecheck": "turbo typecheck",
    "test": "turbo test",
    "lint:sql-safety": "./scripts/lint-sql-safety.sh",
    "lint:audit-suppressions": "./scripts/validate-audit-suppressions.sh"
  }
  ```
  Note: `turbo lint` (turbo.json below) already `dependsOn` `lint:sql-safety` +
  `lint:audit-suppressions`, so `pnpm lint` chains them. This plan STILL runs
  `pnpm lint:sql-safety` as its own explicit step so the sql-safety gate is a
  named, legible line in the CI log (it is the gate 006 makes green). Running it
  twice is a harmless shell lint.

- `turbo.json` — `test` task declares `"env": ["POSTGRES_URL"]` and
  `"cache": false`; `lint` `dependsOn: ["^build", "lint:sql-safety", "lint:audit-suppressions"]`.

- `docker-compose.test.yml` — the Postgres service the CI brings up. Fixed facts:
  - service name `postgres-test`, image `postgres:16-alpine`
  - env: `POSTGRES_USER=nexus`, `POSTGRES_PASSWORD=nexus`, `POSTGRES_DB=nexus_test`
  - host port mapping `5433:5432` (connect on `localhost:5433`)
  - has a `pg_isready` healthcheck (interval 5s, 5 retries)
  - Its header comment documents the canonical test URL:
    `POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test`

- `apps/agent/src/testing/live-pg.ts` — **the load-bearing gate**. Full file:
  ```ts
  export const hasLivePg =
    process.env.NEXUS_PG_TESTS === "1" && !!process.env.POSTGRES_URL;
  ```
  Every PG-backed test uses `describe.skipIf(!hasPg)(...)`. This means setting
  `POSTGRES_URL` alone is NOT enough — the tests stay skipped unless
  `NEXUS_PG_TESTS=1` is ALSO set. If CI omits `NEXUS_PG_TESTS=1`, the Postgres
  container is started for nothing and the DB integration tests never run. The
  CI test step MUST export BOTH.

- `NEXUS_ATTACH_SECRET` — `apps/agent/src/routes/notifications-deliver.test.ts`
  reads it (`SECRET_ENV = "NEXUS_ATTACH_SECRET"`). Test-only value `test` is fine
  to hardcode in the workflow (it is not a real secret).

- `NEXUS_HEAVY_TESTS` — do **NOT** set this in CI.
  `apps/agent/src/testing/homelab-transport.test.ts` opts in cross-host
  Tailscale round-trips to the live homelab agent when it is `1`; those require
  the real homelab and would fail in CI. Leaving it unset keeps those legs
  skipped (they gate on `heavyEnabled = process.env.NEXUS_HEAVY_TESTS === "1"`).

- Packages that actually have a `test` script (what `turbo test` fans out to):
  `apps/agent` (`bun test`) and `apps/nexus-statusline`. `packages/db` has no
  test script. The PG-backed suites self-provision isolated schemas via
  `CREATE SCHEMA` + inline DDL (see `apps/agent/src/db/database.test.ts`
  `buildIsolatedDb`), so **no `db:migrate`/schema pre-apply step is needed** — a
  reachable empty Postgres at `POSTGRES_URL` is sufficient.

- `pnpm-lock.yaml` exists at repo root (so `--frozen-lockfile` is valid).

- Runtime: `apps/agent` builds/tests with **Bun** (`bun test`, `bun build`), the
  monorepo is managed with **pnpm@9.15.0**. CI needs BOTH toolchains installed.

Conventions to honor:
- Commit messages: Conventional Commits. Use `ci:` (or `chore(ci):`) for this
  workflow. Example from `git log`: `feat(notifications): add telegram channel ...`.
- The repo has no existing workflow to model after — this is the first one.

## Commands you will need

| Purpose            | Command                                                  | Expected on success            |
|--------------------|----------------------------------------------------------|--------------------------------|
| Install            | `pnpm install --frozen-lockfile`                         | exit 0                         |
| Typecheck          | `pnpm typecheck`                                          | exit 0, no errors              |
| Lint               | `pnpm lint`                                               | exit 0                         |
| SQL-safety gate    | `pnpm lint:sql-safety`                                    | exit 0                         |
| Tests              | `pnpm test`                                               | exit 0, all pass               |
| Start test PG      | `docker compose -f docker-compose.test.yml up -d`        | container `postgres-test` up   |
| Stop test PG       | `docker compose -f docker-compose.test.yml down -v`      | exit 0                         |
| YAML sanity (opt.) | `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` | no output, exit 0 |

(Exact commands verified from `package.json` / `docker-compose.test.yml` during recon.)

## Suggested executor toolkit

- Skill `deploy-and-env` if available — CI/CD + env-var conventions for this fleet.
- GitHub-hosted `ubuntu-latest` runners ship Docker + the `docker compose` v2
  plugin preinstalled; no extra install step for Docker is needed.

## Scope

**In scope** (the only file you create):
- `.github/workflows/ci.yml` (create — the `.github/workflows/` directory does
  not exist yet; create it)

**Out of scope** (do NOT touch):
- `deploy/hooks.d/pre-push/01-deploy` — the local hook stays as-is; CI complements
  it, does not replace it. Do not remove the `SKIP_DEPLOY` bypass or the hook.
- `docker-compose.test.yml` — reuse it verbatim; do not edit ports/creds.
- Any `package.json` / `turbo.json` — reuse existing scripts; invent no new ones.
- Any source file, test file, or Swift file.
- The macOS/Swift job is a **documented stub only** (see Step 3) — do NOT wire a
  real `xcodebuild` job unless a macOS runner is confirmed available (STOP first).

## Git workflow

- Branch: `advisor/013-add-ci-workflow`
- Single commit; Conventional Commits style, e.g.
  `ci: add neutral GitHub Actions workflow running typecheck/lint/test on push+PR`
- Do NOT push and do NOT open a PR (the operator did not authorize it).

## Steps

### Step 1: Create the workflow directory and the Linux gate job

Create `.github/workflows/ci.yml`. Trigger on `push` and `pull_request`. One
required Linux job named `linux-gates` on `ubuntu-latest`. The job MUST:

1. `actions/checkout@v4`
2. Install pnpm: `pnpm/action-setup@v4` with `version: 9.15.0` (matches the root
   `packageManager` field).
3. Install Node: `actions/setup-node@v4` with `node-version: 22` and
   `cache: pnpm` (Node 22 matches the repo's `@types/node ^22`; pnpm needs a
   Node runtime, and turbo/eslint run on Node).
4. Install Bun: `oven-sh/setup-bun@v2` (the agent's tests run under `bun test`).
5. `pnpm install --frozen-lockfile`
6. Bring up Postgres: `docker compose -f docker-compose.test.yml up -d --wait`
   (the `--wait` flag blocks until the compose healthcheck reports healthy — no
   arbitrary `sleep` needed; the service already defines a `pg_isready`
   healthcheck).
7. `pnpm typecheck`
8. `pnpm lint`
9. `pnpm lint:sql-safety`
10. `pnpm test` — this step MUST set these env vars (job- or step-level `env:`):
    - `POSTGRES_URL: postgres://nexus:nexus@localhost:5433/nexus_test`
    - `NEXUS_PG_TESTS: "1"`  ← REQUIRED, else PG tests silently skip (see Current state)
    - `NEXUS_ATTACH_SECRET: test`
    Do NOT set `NEXUS_HEAVY_TESTS` (would trigger live-homelab tests that fail in CI).
11. (Optional, recommended) an `if: always()` teardown step:
    `docker compose -f docker-compose.test.yml down -v`.

Target shape (fill in the exact indentation; this is the pattern, not a
byte-for-byte mandate):

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  linux-gates:
    name: Linux gates (typecheck / lint / test)
    runs-on: ubuntu-latest
    env:
      POSTGRES_URL: postgres://nexus:nexus@localhost:5433/nexus_test
      NEXUS_PG_TESTS: "1"
      NEXUS_ATTACH_SECRET: test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - uses: oven-sh/setup-bun@v2
      - run: pnpm install --frozen-lockfile
      - run: docker compose -f docker-compose.test.yml up -d --wait
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm lint:sql-safety
      - run: pnpm test
      - if: always()
        run: docker compose -f docker-compose.test.yml down -v
```

**Verify**:
- `test -f .github/workflows/ci.yml` → exit 0
- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` →
  no output, exit 0 (valid YAML). If `python3`/`pyyaml` is unavailable, use any
  YAML linter present (`yamllint`, `npx yaml-lint`); if none, skip — the grep
  check in Step 2 is the load-bearing verification.

### Step 2: Confirm every command in the workflow exists in the repo

The workflow must invoke only real scripts. Verify each referenced `pnpm <x>`
maps to a script in `package.json`:

**Verify** (each must print a match):
```
grep -q '"typecheck"'       package.json && echo OK-typecheck
grep -q '"lint"'            package.json && echo OK-lint
grep -q '"lint:sql-safety"' package.json && echo OK-sqlsafety
grep -q '"test"'            package.json && echo OK-test
test -f docker-compose.test.yml && echo OK-compose
```
Expected: five `OK-*` lines. If any is missing, the plan has drifted — STOP.

### Step 3: Add the macOS/Swift job as a documented, non-wired stub

The macOS Swift schemes (`nexus-mac`, `NexusShared`) cannot be tested on a Linux
runner, and GitHub-hosted macOS runners are metered/opt-in. Do NOT wire a real
`xcodebuild test` job in this plan. Instead, append a **commented** stub block at
the end of `ci.yml` documenting the intended job, so the next contributor with a
macOS runner can uncomment it:

```yaml
# ── macOS Swift job (STRETCH — not wired) ─────────────────────────────
# Requires a macOS runner (GitHub-hosted `macos-14` is metered, or a
# self-hosted Mac). When a runner is available, uncomment and finish:
#
#   macos-swift:
#     name: Swift gates (nexus-mac, NexusShared)
#     runs-on: macos-14
#     steps:
#       - uses: actions/checkout@v4
#       - run: brew install xcodegen
#       - run: cd apps/swift && xcodegen generate
#       - run: |
#           xcodebuild test \
#             -project apps/swift/nexus.xcodeproj \
#             -scheme nexus-mac \
#             -destination 'platform=macOS' \
#             -only-testing:nexus-mac-Tests \
#             -only-testing:NexusSharedTests \
#             CODE_SIGNING_ALLOWED=NO
#
# Follow-up: iOS/watch bundle coverage is a separate gap — see plans/014.
```

If — and only if — the operator has told you a macOS runner IS configured, STOP
and report before wiring it live (it is out of this plan's LOW-risk scope and
needs a runner decision).

**Verify**: `grep -q 'macos-swift' .github/workflows/ci.yml && echo OK-stub`
→ prints `OK-stub` (the commented stub is present).

### Step 4: Commit on the advisor branch

```
git checkout -b advisor/013-add-ci-workflow
git add .github/workflows/ci.yml
git commit -m "ci: add neutral GitHub Actions workflow running typecheck/lint/test on push+PR"
```
Do NOT push. Do NOT open a PR.

**Verify**: `git show --stat HEAD` lists exactly `.github/workflows/ci.yml` added.

## Test plan

This plan adds a workflow, not code, so there are no unit tests to write. The
"tests" are structural:

- **YAML validity**: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"`
  exits 0 (Step 1).
- **Command existence**: the Step 2 grep block prints all five `OK-*` lines.
- **Stub present**: Step 3 grep prints `OK-stub`.
- The authoritative end-to-end verification (workflow runs green on a branch)
  cannot happen here because this plan must NOT push. That verification is
  deferred to the first real push of this branch by the operator.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.github/workflows/ci.yml` exists (`test -f .github/workflows/ci.yml`)
- [ ] File is valid YAML (parser exits 0)
- [ ] Every `pnpm <script>` in the workflow exists in `package.json` (Step 2: five `OK-*` lines)
- [ ] Workflow sets `POSTGRES_URL`, `NEXUS_PG_TESTS=1`, and `NEXUS_ATTACH_SECRET=test` on the test step, and does NOT set `NEXUS_HEAVY_TESTS`
- [ ] Workflow brings up `docker-compose.test.yml` before `pnpm test`
- [ ] macOS Swift job is present only as a commented stub (`grep -q 'macos-swift'` matches; it is inside a comment block)
- [ ] No file other than `.github/workflows/ci.yml` is modified (`git status`)
- [ ] `plans/README.md` status row for 013 updated (if you maintain the index)

## STOP conditions

Stop and report back (do not improvise) if:

- Any excerpt in "Current state" no longer matches the live file (drift since
  `64a206ff`) — in particular if `live-pg.ts` no longer gates on `NEXUS_PG_TESTS`,
  or if the compose service port/creds/DB name changed.
- `pnpm test` locally (with the three env vars set and the compose Postgres up)
  requires any secret or service BEYOND the docker-compose Postgres — e.g. a
  reachable homelab agent, a real `POSTGRES_URL` to the shared DB, a Tailscale
  peer, or an external API token. Report exactly which. Do NOT weaken the gate
  (do not drop `NEXUS_PG_TESTS`, do not add `continue-on-error`, do not delete
  the failing test) to force it green.
- A root script referenced by the workflow (`typecheck`/`lint`/`lint:sql-safety`/
  `test`) is missing from `package.json`.
- The operator states a macOS runner is available and wants the Swift job wired
  live (out of this plan's scope — needs a separate decision).
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns CI after this lands:

- **Bun/pnpm pins**: `pnpm` is pinned to `9.15.0` (matches `packageManager`).
  `oven-sh/setup-bun@v2` currently resolves the latest Bun — once the team
  standardizes a Bun version, add `bun-version: <x>` for reproducibility.
- **PG-test gate coupling**: the workflow depends on `apps/agent/src/testing/live-pg.ts`
  gating on `NEXUS_PG_TESTS`. If that gate variable is renamed, update the
  workflow's `env` in lockstep or PG tests silently stop running (green but
  hollow).
- **Reviewer scrutiny**: confirm `NEXUS_HEAVY_TESTS` is NOT set (its presence
  would pull in live-homelab tests and make CI depend on network peers), and that
  the compose Postgres is torn down (`down -v`) so no state leaks between runs.
- **Deferred follow-ups**: (1) the macOS/Swift job (wire when a runner exists);
  (2) iOS/watch bundle coverage — tracked separately, see plans/014;
  (3) Playwright/e2e is not run here (no e2e package with a `test` script was
  found under `turbo test`) — revisit if one is added.
