# Plan 005: Bump drizzle-orm to >=0.45.2 to clear the SQL-injection advisory on the primary data path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 64a206ff..HEAD -- packages/db/package.json apps/agent/package.json pnpm-lock.yaml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

`pnpm audit --prod` reports a HIGH advisory against `drizzle-orm <0.45.2`:
SQL injection via improperly escaped SQL identifiers (column/table names).
drizzle-orm sits on the entire monorepo's data path (`packages/db`,
`packages/core`, `apps/agent`, `tests/e2e`), so the advisory is reachable
project-wide. **Important context for the reviewer**: the accompanying audit
found NO request-data identifier interpolation — every dynamic-identifier site
in this repo interpolates a compile-time Drizzle table object or a config/
migration schema name (see "Current state" below), never a value derived from
an inbound request. So this is a **supply-chain hardening bump**, not an
active-exploit fix. It is still a HIGH advisory and cheap to clear: a two-line
manifest pin bump plus a lockfile regen, gated by the existing snapshot-guard
test to prove the ORM upgrade didn't shift generated output.

## Current state

- `packages/db/package.json:32` — pins `"drizzle-orm": "^0.44.2"` in
  `dependencies`; also `"drizzle-kit": "^0.31.1"` in `devDependencies`
  (line 37).
- `apps/agent/package.json:22` — pins `"drizzle-orm": "^0.44.2"` in
  `dependencies`.
- `pnpm-lock.yaml` — installed `drizzle-orm@0.44.7` (below the 0.45.2 fix),
  installed `drizzle-kit@0.31.10`.
- `packages/core` has no direct drizzle-orm dependency; it is pulled in
  transitively through `@nexus/db`. Do NOT add a pin there.

Identifier-interpolation sites (the advisory's blast radius) — all
compile-time schema objects or config/migration names, none request-derived:

- `apps/agent/src/services/process-watcher.ts:877-878` — interpolates the
  Drizzle table object `processWatcherState` into a `DELETE ... WHERE id NOT IN
  (SELECT ... )`; the object is a static import, not request data.
- `apps/agent/src/db/database.ts:107` — `sql\`SELECT to_regclass(${table})::text\``;
  `table` is bound as a **value** (regclass lookup), not an identifier.
- `apps/agent/src/services/fleet-presence.ts:73-88`,
  `apps/agent/src/credentials/pool/pool-core.ts:378,502,679`,
  `apps/agent/src/scripts/backfill-hook-schema-fingerprints.ts:123` — all
  interpolate static SQL fragments (`now()`, `leased_at asc nulls first`,
  `rate_limit_count + 1`) or schema-column objects, none request-derived.
- `apps/agent/src/db/migration-0010-orphans.test.ts` uses `sql.unsafe(...)`
  with a hardcoded `TEST_SCHEMA` constant — test-only, not a runtime path.

Migration/snapshot machinery this bump must not disturb:

- `packages/db/src/migrate.ts` — deploy-time migrator; uses
  `drizzle-orm/migrator` `readMigrationFiles` + `postgres-js` driver. Applies
  committed `.sql` files; recovery logic depends on the drizzle migrations
  journal shape.
- `packages/db/src/drizzle-snapshot-guard.test.ts` — asserts that running
  `drizzle-kit generate` produces NO new `NNNN_*.sql` migration when the
  schema is unchanged. This is the primary guard that the ORM/kit upgrade
  did not shift snapshot output.

Repo conventions:
- Runtime is Bun for TS; the agent tests run via `bun test`.
- Package manager is `pnpm@9.15.0` (workspace) — use `pnpm install` to regen
  the lockfile, never `npm`/`yarn`.
- Conventional commits — recent example from `git log`:
  `feat(spec): credential-proactive-swap — rotate before exhaustion`.

## Commands you will need

| Purpose            | Command                                                              | Expected on success                          |
|--------------------|---------------------------------------------------------------------|----------------------------------------------|
| Install / lock     | `pnpm install`                                                      | exit 0, lockfile updated to `drizzle-orm@0.45.x` |
| Typecheck (all)    | `pnpm typecheck`                                                    | exit 0, no errors                            |
| Snapshot generate  | `cd packages/db && pnpm db:generate`                               | exit 0, **no new** `NNNN_*.sql` file created |
| Snapshot guard     | `cd packages/db && bun test drizzle-snapshot-guard.test.ts`        | pass                                          |
| Agent tests        | `cd apps/agent && bun test`                                        | all pass                                      |
| Audit (prod)       | `pnpm audit --prod`                                                | no drizzle-orm HIGH advisory                 |

## Scope

**In scope** (the only files you should modify):
- `packages/db/package.json` (the `drizzle-orm` pin; and the `drizzle-kit`
  devDep pin ONLY if Step 2's compatibility check requires it)
- `apps/agent/package.json` (the `drizzle-orm` pin)
- `pnpm-lock.yaml` (regenerated by `pnpm install`, not hand-edited)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):
- Any `.ts` source file. This is a dependency bump. If typecheck fails against
  a 0.44→0.45 API change, that is a **STOP condition** — do NOT patch call
  sites (`process-watcher.ts`, `pool-core.ts`, `migrate.ts`, etc.) to chase
  the bump.
- `packages/core/package.json` — no direct drizzle-orm dep; leave it.
- Any `packages/db/src/migrations/*.sql` or `apps/agent/src/db/drizzle/*.sql`
  file. If `db:generate` wants to write a new migration, that is a STOP
  condition (the ORM upgrade shifted snapshot output), not a file to commit.

## Git workflow

- Branch: `advisor/005-bump-drizzle-orm` (create from current HEAD; do not
  work on `main`).
- Single logical commit; message style: conventional commits. Use
  `chore(deps): bump drizzle-orm to ^0.45.2 (clears HIGH SQL-injection advisory)`
  (or `fix(deps):` if you prefer the security framing — either is acceptable).
- Do NOT push or open a PR. Leave the branch local for review.

## Steps

### Step 1: Verify the exact fixed version

Confirm the lowest patched release in the 0.45.x line before pinning. Run:

```
pnpm view drizzle-orm versions --json | tr ',' '\n' | grep '"0.45'
```

The advisory names `>=0.45.2` as fixed. Pin to `^0.45.2` (which admits the
latest 0.45.x, e.g. 0.45.x resolved by pnpm). If `pnpm view` is offline,
default to `^0.45.2` — the caret range lets the resolver pick the newest
compatible patch.

**Verify**: `pnpm view drizzle-orm@0.45.2 version` → prints `0.45.2` (or the
range resolves; if the network is unavailable, proceed with `^0.45.2` and note
it in your report).

### Step 2: Check drizzle-kit compatibility

`packages/db/package.json` pins `drizzle-kit@^0.31.1` (installed `0.31.10`).
drizzle-kit 0.31.x is the companion line for drizzle-orm 0.44–0.45 and
normally needs no bump. Confirm the peer/compat expectation:

```
pnpm view drizzle-kit@0.31.10 peerDependencies
```

If `drizzle-kit@0.31.10` declares a `drizzle-orm` peer that EXCLUDES 0.45.x,
bump the `drizzle-kit` pin in `packages/db/package.json` to the lowest 0.31.x
(or 0.31→0.31.x) that accepts drizzle-orm 0.45. If it has no restrictive
drizzle-orm peer (the common case), leave drizzle-kit untouched.

**Verify**: note whether a drizzle-kit bump was needed. The real proof is
Step 5 (a clean `db:generate` snapshot) — a snapshot-format mismatch there is
the signal drizzle-kit needs a bump.

### Step 3: Update both manifest pins

Change `"drizzle-orm": "^0.44.2"` → `"drizzle-orm": "^0.45.2"` in BOTH:
- `packages/db/package.json` (line ~32, `dependencies`)
- `apps/agent/package.json` (line ~22, `dependencies`)

**Verify**: `grep -rn '"drizzle-orm"' packages/db/package.json apps/agent/package.json`
→ both show `"^0.45.2"`, no remaining `^0.44.2`.

### Step 4: Regenerate the lockfile

```
pnpm install
```

**Verify**: `grep -n 'drizzle-orm@0.45' pnpm-lock.yaml` → matches; and
`grep -n 'drizzle-orm@0.44' pnpm-lock.yaml` → returns nothing.

### Step 5: Verify no API break and no snapshot drift

Run, in order:

```
pnpm typecheck
cd packages/db && pnpm db:generate
```

- `pnpm typecheck` → exit 0, no errors. (If it fails, STOP — see conditions.)
- `db:generate` → must create NO new `NNNN_*.sql` file. Check with
  `git status --porcelain packages/db packages/db/src apps/agent/src/db` — the
  only expected changes are the two `package.json` files and `pnpm-lock.yaml`
  from prior steps. A new `.sql` migration or a changed snapshot meta file is
  a STOP condition.

Then run the guard + agent tests:

```
cd packages/db && bun test drizzle-snapshot-guard.test.ts
cd apps/agent && bun test
```

Both must pass. `apps/agent` tests may require `NEXUS_ATTACH_SECRET=test` and a
reachable `POSTGRES_URL` for the PG-integration tests — set them per the repo's
test env convention if the suite reports missing env (do NOT invent secret
values; use `NEXUS_ATTACH_SECRET=test`).

**Verify**: all four commands above pass with the expected results.

### Step 6: Confirm the advisory is cleared

```
pnpm audit --prod
```

**Verify**: the drizzle-orm HIGH SQL-injection advisory is no longer listed.
(Other unrelated advisories, if any, are out of scope for this plan.)

### Step 7: Commit

Stage only the in-scope files and commit:

```
git checkout -b advisor/005-bump-drizzle-orm
git add packages/db/package.json apps/agent/package.json pnpm-lock.yaml
git commit -m "chore(deps): bump drizzle-orm to ^0.45.2 (clears HIGH SQL-injection advisory)"
```

Do NOT push.

## Test plan

No new tests — this is a dependency bump gated by existing coverage:
- `packages/db/src/drizzle-snapshot-guard.test.ts` proves the ORM/kit upgrade
  did not shift generated migration output.
- `apps/agent` `bun test` (incl. `migrate.test.ts`,
  `db/migration-0010-orphans.test.ts`, `db/health.ts` callers) exercises the
  migrator and the `sql`-interpolation runtime paths under the new ORM.
- Verification: all suites pass; `pnpm audit --prod` shows the advisory gone.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -rn '"drizzle-orm"' packages/db/package.json apps/agent/package.json` shows `^0.45.2` in both, no `^0.44.2` remaining
- [ ] `grep -n 'drizzle-orm@0.44' pnpm-lock.yaml` returns no matches
- [ ] `pnpm typecheck` exits 0
- [ ] `cd packages/db && pnpm db:generate` creates no new `NNNN_*.sql` migration (clean `git status`)
- [ ] `cd packages/db && bun test drizzle-snapshot-guard.test.ts` passes
- [ ] `cd apps/agent && bun test` passes
- [ ] `pnpm audit --prod` no longer reports the drizzle-orm HIGH advisory
- [ ] No `.ts`/`.sql` source files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The pins in "Current state" don't read `^0.44.2` (the manifests drifted
  since this plan was written).
- `pnpm typecheck` fails after the bump — 0.45 changed a drizzle-orm API this
  repo uses. Report the exact TypeScript error and file:line. Do NOT patch
  call sites to make it compile.
- `cd packages/db && pnpm db:generate` produces a new `NNNN_*.sql` migration or
  a changed snapshot/meta file — the ORM (or drizzle-kit) upgrade shifted
  generated output. Report the diff; do NOT commit the generated migration.
- The snapshot-guard or agent tests fail after the bump (and the failure is
  not a missing-env-var issue you can resolve with `NEXUS_ATTACH_SECRET=test`
  + `POSTGRES_URL`). Report the failing test and output.
- Step 2 reveals drizzle-kit 0.31.x is incompatible with drizzle-orm 0.45.x
  and the required drizzle-kit bump is a major version (0.31→0.4x) — that
  expands scope; report and ask before proceeding.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **What a reviewer should scrutinize**: that ONLY the two `package.json` pins
  and `pnpm-lock.yaml` changed — no `.ts` source, no new `.sql` migration. A
  clean `db:generate` diff is the load-bearing signal that the minor bump was
  transparent.
- **Future interaction**: if a future feature interpolates a *request-derived*
  identifier (column/table name from user input) via drizzle `sql`, this
  advisory's threat model becomes live — that code must stay on a patched
  drizzle-orm and should prefer parameter binding over identifier
  interpolation. The current sites (process-watcher, pool-core,
  fleet-presence) are all static schema objects and are safe.
- **Deferred**: broader dependency-freshness sweep across the monorepo is out
  of scope here; this plan clears only the one HIGH advisory.
