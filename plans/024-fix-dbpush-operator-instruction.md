# Plan 024: Replace the banned db:push instruction in SchemaIncompleteError with db:migrate; install the db-push pre-commit guard

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. When you mark the row DONE/BLOCKED/REJECTED, append
> `spec-impact: <slug>[, ...]` or `spec-impact: none` to the row (handoff rule).
>
> **Drift check (run first)**:
> ```
> git diff --stat b7096486..HEAD -- apps/agent/src/db/database.ts apps/agent/src/db/database.test.ts docker-compose.test.yml apps/agent/src/routes/sessions.test.ts packages/core/src/types/health.ts .beads/hooks/pre-commit scripts/hooks/
> ```
> Expected: **empty output** (no in-scope file changed since this plan was
> written — verified true at plan-authoring time, when HEAD was `d458ef8e`,
> one beads-sync commit past `b7096486`). If any in-scope file shows in the
> diff, compare the "Current state" excerpts below against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.
> Leo works directly in this checkout — expect `main` to advance while you
> execute; that is why you run in a worktree and why this check exists.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (see the CI note under "Commands you will need" re plan 023)
- **Category**: bug (operator-facing guidance that reproduces a data-loss incident)
- **Planned at**: commit `b7096486`, 2026-07-11

## Why this matters

The agent's startup-blocking `SchemaIncompleteError` — the error an operator
sees when the `nexus` database exists but has missing tables — instructs the
operator to run `pnpm --filter @nexus/db db:push (or drizzle-kit push)`.
That is the exact command this repo **banned** after the nx-vtzmd incident
(2026-06-20): `db:push` is a state-based live-diff that skips the
`drizzle.__drizzle_migrations` journal, can silently drop columns, and
collides with the deploy's `db:migrate` replay ("already exists" drift).
Worse, `db:push` is not even a script in `packages/db/package.json` anymore
(scripts are `db:generate` / `db:migrate` / `db:studio` only), so the first
half of the instruction fails outright — pushing the operator toward the
parenthetical `drizzle-kit push`, which DOES work and replays the incident
against the shared homelab DB. Nothing currently catches the string: this
plan fixes the message plus three sibling prose sites, and installs the
fleet pre-commit guard so the banned command cannot be silently reintroduced.

## Current state

All excerpts below are fresh reads at commit `b7096486` (byte-identical at
`d458ef8e`, the HEAD at authoring time).

### 1. The operator-facing error message — `apps/agent/src/db/database.ts:49-56`

```ts
    super(
      `Schema verification failed: missing tables [${missingTables.join(", ")}]. ` +
        `The \`${locationHint.database ?? "nexus"}\` database at ${location} ` +
        `exists but Drizzle migrations have not been applied. ` +
        `Run: pnpm --filter @nexus/db db:push (or drizzle-kit push) against ` +
        `POSTGRES_URL before starting the agent. ` +
        `Set ${SKIP_ENV_VAR}=1 to bypass this check (unsafe for production).`,
    );
```

This error is caught in `apps/agent/src/index.ts` and converted to
`process.exit(1)` (per the class docstring at lines 31-35), so this text is
exactly what a stuck operator reads at 2am.

### 2. The test that pins the wrong message — `apps/agent/src/db/database.test.ts:216-220`

```ts
    // The message MUST be actionable — mention drizzle-kit push and the
    // POSTGRES_URL hint per the spec.
    expect(err.message).toContain("notifications");
    expect(err.message.toLowerCase()).toContain("drizzle-kit push");
    expect(err.message).toContain("POSTGRES_URL");
```

This lives inside `describe.skipIf(!hasPg)(...)` (line 181) — it only runs
with a live Postgres (`hasPg` = `NEXUS_PG_TESTS === "1" && !!POSTGRES_URL`,
from `apps/agent/src/testing/live-pg.ts`). CI sets both (see
`.github/workflows/ci.yml` job env: `NEXUS_PG_TESTS: "1"` plus the compose
`POSTGRES_URL`), so CI DOES exercise this assertion.

### 3. Known Wave-2 leftover — `docker-compose.test.yml:10-11`

```yaml
#   3. Apply the schema:
#        POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test pnpm --filter @nexus/db db:push
```

CI itself already does this correctly (`.github/workflows/ci.yml:57-59`:
"Migration-based ONLY (`db:migrate` = `bun ./src/migrate.ts`); NEVER
`db:push`." then `run: pnpm --filter @nexus/db db:migrate`). Only the
compose header comment is stale.

### 4. Sibling prose instruction — `apps/agent/src/routes/sessions.test.ts:10-15`

```ts
 * To run locally against a THROWAWAY test database:
 *   1. Start a PostgreSQL instance (see docker-compose.test.yml at project root)
 *   2. Run `pnpm db:push` in packages/db to create tables
 *   3. export POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test
```

### 5. Sibling prose instruction — `packages/core/src/types/health.ts:72-78`

```ts
  /**
   * Companion to `schema_ok` — list of required tables that were absent on
   * the connected database. Empty / omitted when `schema_ok` is true.
   * Surfaces in `GET /health` so an operator can copy the table list into
   * the `drizzle-kit push` follow-up without re-running the probe.
   */
  schema_missing?: string[];
```

### 6. The hook chain this repo actually runs

`git config --get core.hooksPath` in this repo returns the **absolute** path
`/home/nyaptor/dev/personal/nexus/.beads/hooks` (set by `bd hooks install
--beads`). Two consequences you MUST internalize:

- Editing `.git/hooks/pre-commit` is a silent no-op — git never runs it here.
- Because the configured path is absolute and worktrees share `.git/config`,
  a `git commit` **inside your execution worktree** runs the MAIN checkout's
  copy of `.beads/hooks/pre-commit`, not your worktree's edited copy. Your
  edit to `.beads/hooks/pre-commit` is a normal tracked-file change (it IS
  git-tracked — `git ls-files .beads/hooks/` lists it) that goes live in the
  main checkout only after merge. Therefore Step 7's guard verification runs
  the guard **script directly**, never via `git commit`.

Current full content of `.beads/hooks/pre-commit` (25 lines — a pure beads
managed block, nothing appended yet):

```sh
#!/usr/bin/env sh
# --- BEGIN BEADS INTEGRATION v0.63.3 ---
# This section is managed by beads. Do not remove these markers.
if command -v bd >/dev/null 2>&1; then
  export BD_GIT_HOOK=1
  _bd_timeout=${BEADS_HOOK_TIMEOUT:-300}
  if command -v timeout >/dev/null 2>&1; then
    timeout "$_bd_timeout" bd hooks run pre-commit "$@"
    _bd_exit=$?
    if [ $_bd_exit -eq 124 ]; then
      echo >&2 "beads: hook 'pre-commit' timed out after ${_bd_timeout}s — continuing without beads"
      _bd_exit=0
    fi
  else
    bd hooks run pre-commit "$@"
    _bd_exit=$?
  fi
  if [ $_bd_exit -eq 3 ]; then
    echo >&2 "beads: database not initialized — skipping hook 'pre-commit'"
    _bd_exit=0
  fi
  if [ $_bd_exit -ne 0 ]; then exit $_bd_exit; fi
fi
# --- END BEADS INTEGRATION v0.63.3 ---
```

You will append AFTER the `# --- END BEADS INTEGRATION v0.63.3 ---` marker.
NEVER insert inside the managed block (it nests calls inside `if command -v
timeout` branches; inserting there silently changes when the guard runs).

### 7. Repo facts you need (inlined — do not go hunting)

- pnpm + Bun monorepo, NOT standard T3 (no tRPC).
- Quality gates: `pnpm typecheck`, `pnpm lint`, `bun test` (root `bun test`
  discovers all `*.test.ts`), `pnpm lint:sql-safety`
  (= `./scripts/lint-sql-safety.sh`).
- CI (`.github/workflows/ci.yml`) runs typecheck/lint/lint:sql-safety/test
  and is **RED on main since 2026-07-10 solely due to a lint-sql-safety
  false positive** (plan 023 fixes it). Until 023 lands, your success bar is
  "no NEW failures attributable to the files this plan changed", not "CI
  fully green".
- Migration policy: drizzle MIGRATION-ONLY. Edit schema ->
  `pnpm --filter @nexus/db db:generate` -> commit the `.sql` -> deploy runs
  `pnpm --filter @nexus/db db:migrate` against `POSTGRES_URL`. The push
  command is BANNED (nx-vtzmd).
- `packages/db/package.json` scripts: `db:generate`, `db:migrate`
  (`bun ./src/migrate.ts`), `db:studio`, `lint`, `typecheck`. There is no
  push script.
- Bun tests may need `NEXUS_ATTACH_SECRET=test` in the environment for the
  full suite (notifications tests read it); the single files you run below
  do not, but exporting it is harmless.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install deps | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| This plan's test file (no PG needed) | `bun test apps/agent/src/db/database.test.ts` | 0 fail (PG suites report skipped without `NEXUS_PG_TESTS=1`) |
| Optional PG-backed run | `docker compose -f docker-compose.test.yml up -d --wait` then `POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test pnpm --filter @nexus/db db:migrate` then `NEXUS_PG_TESTS=1 POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test bun test apps/agent/src/db/database.test.ts` | all pass, 0 fail |
| SQL-safety lint | `pnpm lint:sql-safety` | KNOWN RED until plan 023 lands — pass criterion is: output identical to a pre-change baseline run (capture it before your first edit) |

## Scope

**In scope** (the only files you may modify):

- `apps/agent/src/db/database.ts` — ONLY the constructor message string at
  lines 49-56. Do NOT touch the comment at lines 184-186 (see out-of-scope).
- `apps/agent/src/db/database.test.ts` — update the message assertion
  (lines 216-220) + add one new PG-free test.
- `docker-compose.test.yml` — line 11 header comment only.
- `apps/agent/src/routes/sessions.test.ts` — line 12 doc-comment only.
- `packages/core/src/types/health.ts` — lines 75-76 docstring only.
- `scripts/hooks/pre-commit-block-db-push.sh` — NEW file (new `scripts/hooks/`
  directory; `scripts/` currently holds only flat lint/install scripts).
- `.beads/hooks/pre-commit` — append the guard invocation block after the
  beads END marker.
- `plans/README.md` — status row only, at the end.

**Out of scope** (do NOT touch, even though grep finds the banned token there):

- `packages/db/src/migrate.ts` + `packages/db/src/migrate.test.ts` — their
  many push mentions DESCRIBE the journal-healing recovery logic for
  historical push drift; they are load-bearing documentation of code
  behavior, not instructions.
- `apps/agent/src/db/database.ts:184-186` — the comment
  `// ... even when migrations were bypassed (drizzle-kit push, partial restore,`
  lists historical causes of drift; descriptive, not an instruction. Leave it.
- `openspec/changes/archive/**` — historical records; never edit archives.
- `deploy/POSTGRES_SCHEMA_MAP.md`, `docs/runbook-credential-encryption.md`,
  `tests/e2e/README.md`, `.github/workflows/ci.yml`,
  `openspec/specs/remote-deploy-fanout/spec.md` — all already state the ban
  correctly (negation-marked mentions).
- `packages/core/src/types/health.ts` beyond the one docstring — no type or
  field changes; Swift clients decode this shape.
- `scripts/lint-sql-safety.sh` — plan 023 owns it. Do not extend it here.
- Any schema file or migration under `packages/db/` — this plan generates NO
  migration and runs NO command against any database except the optional
  throwaway compose DB.
- `apps/agent/src/services/credential-usage-poller.{ts,test.ts}` — a
  concurrent session had uncommitted edits there at authoring time; not
  yours.

## Git workflow

- Execute in a worktree; branch: `advisor/024-fix-dbpush-operator-instruction`.
- Single commit at the end (message style from `git log`: conventional
  commits, e.g. `fix(agent): replace banned push instruction in SchemaIncompleteError; install db-push pre-commit guard`).
- Stage explicit file paths only — never `git add .` or `git add -A`.
- Do NOT push or merge unless the operator instructed it.

## Steps

### Step 0: Baseline

From the worktree root, run the drift check from the header (expect empty),
then capture the sql-safety baseline:

```
pnpm lint:sql-safety > /tmp/024-sqlsafety-before.txt 2>&1; echo "exit=$?"
```

Expected: `exit=1` with the known plan-023 false positive in the output
(if it exits 0, plan 023 already landed — fine either way; the criterion in
Step 8 is "identical output before vs after").

### Step 1: Rewrite the SchemaIncompleteError remediation sentence

In `apps/agent/src/db/database.ts`, replace ONLY these two concatenation
segments (currently lines 53-54):

```ts
        `Run: pnpm --filter @nexus/db db:push (or drizzle-kit push) against ` +
        `POSTGRES_URL before starting the agent. ` +
```

with:

```ts
        `Run: pnpm --filter @nexus/db db:migrate against ` +
        `POSTGRES_URL before starting the agent (applies the committed ` +
        `drizzle migrations; schema changes are migration-based only). ` +
```

Do not mention the banned command anywhere in the new text — the message
should state the sanctioned path, not re-litigate the ban. Leave every other
segment of the message (missing-tables list, location, `SKIP_ENV_VAR`
sentence) byte-identical.

**Verify**: `grep -n "db:push" apps/agent/src/db/database.ts` → no output.
`grep -n "db:migrate" apps/agent/src/db/database.ts` → exactly one hit inside
the `super(...)` call.

### Step 2: Fix the message assertions and add a PG-free pin test

In `apps/agent/src/db/database.test.ts`:

(a) Replace lines 216-219:

```ts
    // The message MUST be actionable — mention drizzle-kit push and the
    // POSTGRES_URL hint per the spec.
    expect(err.message).toContain("notifications");
    expect(err.message.toLowerCase()).toContain("drizzle-kit push");
```

with:

```ts
    // The message MUST be actionable — mention the sanctioned db:migrate
    // command and the POSTGRES_URL hint per the spec.
    expect(err.message).toContain("notifications");
    expect(err.message).toContain("pnpm --filter @nexus/db db:migrate");
```

(keep the existing `expect(err.message).toContain("POSTGRES_URL");` line).

(b) Add a NEW describe block at the end of the file that does NOT require a
live PG (it constructs the error directly — `SchemaIncompleteError` is
already imported at the top of the file):

```ts
// ─── SchemaIncompleteError message contract (no PG required) ────────────────
// Pins the operator remediation text to the sanctioned migration-only path.
// Context: nx-vtzmd (2026-06-20) — the previous message instructed the
// state-based push command, which skips the migrations journal and can
// silently drop columns on the shared homelab DB.
describe("SchemaIncompleteError message", () => {
  it("instructs db:migrate and never the banned push command", () => {
    const err = new SchemaIncompleteError(["notifications"], {
      host: "localhost:5436",
      database: "nexus",
    });
    expect(err.message).toContain("pnpm --filter @nexus/db db:migrate");
    expect(err.message).toContain("POSTGRES_URL");
    expect(err.message).toContain("localhost:5436/nexus");
    expect(err.message).not.toContain("db:push"); // banned (nx-vtzmd)
    expect(err.message).not.toContain("drizzle-kit push"); // banned (nx-vtzmd)
  });
});
```

IMPORTANT: keep the two `// banned (nx-vtzmd)` inline comments exactly as
written. The pre-commit guard you install in Step 6 scans ADDED diff lines
for the push tokens and waives lines carrying a negation marker (`banned`
matches its heuristic); without those comments your own commit would be
rejected by the guard you just installed.

**Verify**: `bun test apps/agent/src/db/database.test.ts` → the new
"SchemaIncompleteError message" test passes, 0 fail (live-PG suites skip
without `NEXUS_PG_TESTS=1` — that is expected).

### Step 3: Fix the docker-compose.test.yml header comment

Replace line 11:

```
#        POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test pnpm --filter @nexus/db db:push
```

with:

```
#        POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test pnpm --filter @nexus/db db:migrate
```

(This is exactly the command CI already runs — `.github/workflows/ci.yml:59`.)

**Verify**: `grep -n "db:push" docker-compose.test.yml` → no output.
`docker compose -f docker-compose.test.yml config -q; echo $?` → `0`
(file still parses; skip this sub-check if docker is unavailable and note it).

### Step 4: Fix the sessions.test.ts run instructions

In `apps/agent/src/routes/sessions.test.ts`, replace line 12:

```ts
 *   2. Run `pnpm db:push` in packages/db to create tables
```

with:

```ts
 *   2. Run `pnpm --filter @nexus/db db:migrate` to apply the committed migrations
```

**Verify**: `grep -n "db:push" apps/agent/src/routes/sessions.test.ts` → no output.

### Step 5: Fix the health.ts docstring

In `packages/core/src/types/health.ts`, replace lines 75-76:

```ts
   * Surfaces in `GET /health` so an operator can copy the table list into
   * the `drizzle-kit push` follow-up without re-running the probe.
```

with:

```ts
   * Surfaces in `GET /health` so an operator can see which tables the
   * `db:migrate` follow-up must create without re-running the probe.
```

No type/field changes — comment only.

**Verify**: `grep -n "drizzle-kit push" packages/core/src/types/health.ts` →
no output. `pnpm typecheck` → exit 0.

### Step 6: Commit the guard script into the repo

Create `scripts/hooks/pre-commit-block-db-push.sh` (new directory). The
canonical template lives at
`~/.claude/skills/t3-code-patterns/templates/pre-commit-block-db-push.sh` —
copy it verbatim if that path exists on this machine:

```
mkdir -p scripts/hooks
cp ~/.claude/skills/t3-code-patterns/templates/pre-commit-block-db-push.sh scripts/hooks/pre-commit-block-db-push.sh
chmod +x scripts/hooks/pre-commit-block-db-push.sh
```

If the template path does not exist, write the file with EXACTLY this
content (it is the full template, inlined here so this plan is
self-contained):

```bash
#!/usr/bin/env bash
# Pre-commit hook: block re-introduction of the declarative `db:push` command.
#
# Rejects staged files that ADD a `db:push` / `drizzle-kit push` invocation
# (scripts, package.json scripts, task files, docs that instruct it).
#
# Why: `db:push` (drizzle-kit push) is a state-based live-diff — it mutates the
# DB to match the schema WITHOUT writing the `drizzle.__drizzle_migrations`
# journal, can silently do destructive column drops/alters to converge, and
# collides with the deploy's `db:migrate` file replay -> "already exists" drift
# (the nx-vtzmd incident, 2026-06-20).
#
# Schema changes are migration-based ONLY:
#   edit schema.ts -> `pnpm drizzle-kit generate` (ordered, reviewable .sql)
#                  -> COMMIT the migration
#                  -> the DEPLOY applies it via `pnpm db:migrate` (single writer)
# Test a migration against a THROWAWAY/local DB with `db:migrate` — never
# `db:push` against a shared/prod database.
#
# Install: copy to .git/hooks/pre-commit or chain from your existing pre-commit.
# Bypass: `git commit --no-verify` (use sparingly, document why — e.g. editing
#         this hook itself, or annotating a historical/archived reference).

set -eu

# Match `db:push` or `drizzle-kit push` only when NOT immediately negated/quoted
# as a forbidding mention. We scan ADDED lines (leading '+') in the staged diff
# so we catch re-introduction even inside otherwise-allowed files (docs/package.json).
#
# A line is a violation if it contains the command token AND does not also contain
# a negation marker (never / forbid / banned / block / NOT used / instead of) that
# signals it is documenting the prohibition rather than endorsing the command.

pattern='(db:push|drizzle-kit[[:space:]]+push)'
negation='([Nn]ever|[Ff]orbid|[Bb]anned|[Bb]lock|NOT used|not used|instead of|do not|don.t|reject)'

# Exclude this guard's own file from the scan: its source necessarily repeats
# `db:push` many times to explain and match against the very thing it forbids,
# and no negation-word heuristic can cleanly cover every one of its own lines
# (e.g. the bare `pattern=` regex definition, or a "Why:"/"Rationale:" line that
# doesn't happen to contain one of the negation trigger words). This caused a
# real self-trigger on first install (2026-07-06) — the guard blocked committing
# itself. A hook re-stating its own prohibition is not a re-introduction.
violations=$(git diff --cached --unified=0 --diff-filter=AM \
  -- . ':!*pre-commit-block-db-push.sh' \
  | grep -E '^\+' \
  | grep -vE '^\+\+\+' \
  | grep -E "$pattern" \
  | grep -vE "$negation" \
  || true)

if [ -n "$violations" ]; then
  echo "ERROR: pre-commit blocked declarative db:push re-introduction:" >&2
  echo "" >&2
  printf '%s\n' "$violations" | sed 's/^/  /' >&2
  echo "" >&2
  echo "Schema changes are MIGRATION-BASED ONLY. NEVER db:push / drizzle-kit push." >&2
  echo "  edit schema.ts -> pnpm drizzle-kit generate -> commit the .sql migration" >&2
  echo "  the deploy applies it via pnpm db:migrate (the single writer to live DBs)." >&2
  echo "" >&2
  echo "Rationale: db:push is a state-based live-diff — it skips the" >&2
  echo "drizzle.__drizzle_migrations journal, can silently drop/alter columns, and" >&2
  echo "collides with the deploy's db:migrate replay -> 'already exists' drift" >&2
  echo "(nx-vtzmd, 2026-06-20). See t3-code-patterns skill, Migrations section." >&2
  echo "" >&2
  echo "If this line documents the prohibition (a 'never db:push' note), add a" >&2
  echo "negation marker so it reads as forbidding, or bypass with:" >&2
  echo "  git commit --no-verify   (document why in the commit message)." >&2
  exit 1
fi
```

The filename MUST be exactly `pre-commit-block-db-push.sh` — the script's own
diff scan self-excludes via the pathspec `':!*pre-commit-block-db-push.sh'`;
rename it and it will block its own future edits.

**Verify**: `bash -n scripts/hooks/pre-commit-block-db-push.sh; echo $?` → `0`
(syntax-clean). `test -x scripts/hooks/pre-commit-block-db-push.sh && echo OK` → `OK`.

### Step 7: Wire the guard into the beads hook chain and prove it bites

(a) Append to `.beads/hooks/pre-commit`, AFTER the final line
`# --- END BEADS INTEGRATION v0.63.3 ---` (never inside the managed block):

```sh

# --- nexus repo guards (keep AFTER the beads managed block) ---------------
# Re-add this block if a future `bd hooks install` reinstall resets this file
# to the bare managed block. Uses --show-toplevel so the guard runs against
# the invoking checkout/worktree's own staged diff and script copy.
_repo_root=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$_repo_root" ] && [ -f "$_repo_root/scripts/hooks/pre-commit-block-db-push.sh" ]; then
  bash "$_repo_root/scripts/hooks/pre-commit-block-db-push.sh" || exit $?
fi
# --- end nexus repo guards -------------------------------------------------
```

(b) Negative test — the guard MUST reject a staged banned string. Run from
the worktree root (this exercises the script directly; remember from
"Current state" item 6 that `git commit` in your worktree would run the MAIN
checkout's hook copy, so direct execution is the correct probe here):

```
printf 'setup: run pnpm --filter @nexus/db db:push first\n' > canary-dbpush.txt
git add canary-dbpush.txt
bash scripts/hooks/pre-commit-block-db-push.sh; echo "guard-exit=$?"
```

Expected: stderr starts with
`ERROR: pre-commit blocked declarative db:push re-introduction:` and the
final line prints `guard-exit=1`.

(c) Clean up the canary, then positive test — with ONLY this plan's real
changes staged, the guard passes:

```
git reset -- canary-dbpush.txt && rm canary-dbpush.txt
git add apps/agent/src/db/database.ts apps/agent/src/db/database.test.ts docker-compose.test.yml apps/agent/src/routes/sessions.test.ts packages/core/src/types/health.ts scripts/hooks/pre-commit-block-db-push.sh .beads/hooks/pre-commit
bash scripts/hooks/pre-commit-block-db-push.sh; echo "guard-exit=$?"
```

Expected: no ERROR output, `guard-exit=0`. (The `not.toContain` test lines
pass because of their `// banned (nx-vtzmd)` markers; the appended hook block
contains only the hyphenated filename `pre-commit-block-db-push.sh`, which
does not match the `db:push` pattern.)

(d) Chain sanity: `sh -n .beads/hooks/pre-commit; echo $?` → `0`, and
`grep -n "END BEADS INTEGRATION" .beads/hooks/pre-commit` shows the marker
line ABOVE your appended block (managed block untouched).

### Step 8: Full gates and commit

```
pnpm typecheck        # expect exit 0
pnpm lint             # expect exit 0
bun test apps/agent/src/db/database.test.ts   # expect 0 fail
pnpm lint:sql-safety > /tmp/024-sqlsafety-after.txt 2>&1; echo "exit=$?"
diff /tmp/024-sqlsafety-before.txt /tmp/024-sqlsafety-after.txt && echo IDENTICAL
```

Expected: typecheck/lint exit 0; test file 0 fail; sql-safety output
`IDENTICAL` to the Step 0 baseline (its known failure belongs to plan 023 —
you must not have added or removed any of its findings).

Then commit the staged files from Step 7c (plus `plans/README.md` after you
update your row) in one conventional commit on
`advisor/024-fix-dbpush-operator-instruction`. If a beads pre-commit step
restages `.beads/issues.jsonl`, that is normal — let it.

## Test plan

- **Modified assertion** (`database.test.ts:219`): live-PG path now pins
  `pnpm --filter @nexus/db db:migrate` in the thrown message. Runs in CI
  (which sets `NEXUS_PG_TESTS=1`) and in the optional local PG run.
- **New test** (`database.test.ts`, "SchemaIncompleteError message"): PG-free
  direct construction; pins the sanctioned command, the `POSTGRES_URL` hint,
  the host/db location, and the ABSENCE of both banned tokens. Model it after
  the excerpt in Step 2b; structurally it matches the file's existing
  bun:test `describe`/`it` style (see the `verifySchema` blocks at lines
  181-228 for the house style).
- **Guard bite**: Step 7b/7c is the runtime evidence — staged canary rejected
  (exit 1 + ERROR), real diff accepted (exit 0). This is a required part of
  done, not optional.
- Verification: `bun test apps/agent/src/db/database.test.ts` → all pass,
  including 1 new test; with PG up, the live-PG describe passes too.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -rn "db:push" apps/agent/src/db/database.ts docker-compose.test.yml apps/agent/src/routes/sessions.test.ts packages/core/src/types/health.ts` → no output
- [ ] `grep -c "not.toContain" apps/agent/src/db/database.test.ts` → `2` (the only remaining push-token mentions in that file are the two negative assertions with `// banned (nx-vtzmd)` markers)
- [ ] `grep -n "drizzle-kit push" apps/agent/src/db/database.ts` → exactly one hit, in the descriptive comment near line 185 (unchanged)
- [ ] `bun test apps/agent/src/db/database.test.ts` → 0 fail, includes the new "SchemaIncompleteError message" test
- [ ] `pnpm typecheck` → exit 0; `pnpm lint` → exit 0
- [ ] `bash scripts/hooks/pre-commit-block-db-push.sh` with a staged file containing the push command → exit 1 with `ERROR:` output (Step 7b transcript)
- [ ] `.beads/hooks/pre-commit`: managed block byte-identical; guard block appended after the END marker (`sh -n` exits 0)
- [ ] `pnpm lint:sql-safety` output identical to the pre-change baseline
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` row for 024 updated, with `spec-impact:` noted

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check in the header is non-empty and any "Current state" excerpt
  no longer matches the live code (especially `database.ts:49-56` or the
  `.beads/hooks/pre-commit` content — a concurrent `bd hooks install` may
  have rewritten the hook, or another plan may have already fixed the
  message).
- `git config --get core.hooksPath` returns anything other than
  `/home/nyaptor/dev/personal/nexus/.beads/hooks` — the hook-chain
  assumptions in Step 7 no longer hold.
- The Step 7b negative test does NOT exit 1, or the Step 7c positive test
  does NOT exit 0 after one re-read of the guard's negation heuristic — do
  not weaken the pattern/negation regexes to force a result.
- `pnpm typecheck` or `pnpm lint` fails on a file this plan touched and one
  reasonable fix attempt doesn't clear it.
- Fixing anything appears to require touching `packages/db/src/migrate.ts`,
  `scripts/lint-sql-safety.sh`, or any `openspec/` path — those are other
  owners' territory (plan 023 owns lint-sql-safety).

## Maintenance notes

- **`bd hooks install` resets the hook**: any beads reinstall may rewrite
  `.beads/hooks/pre-commit` back to the bare managed block, silently
  dropping the guard invocation. The appended block's own comment says to
  re-add it; after any beads upgrade, run
  `grep -n "pre-commit-block-db-push" .beads/hooks/pre-commit` — no hit
  means the guard is unwired.
- **Worktree activation lag**: because `core.hooksPath` is an absolute path
  into the main checkout, the guard only gates real commits once this
  branch's `.beads/hooks/pre-commit` change is merged and checked out in
  `/home/nyaptor/dev/personal/nexus`. Until then it exists but is dormant
  for commits made from worktrees.
- **Negation heuristic, not a parser**: the guard waives added lines
  containing never/forbid/banned/block/etc. A future doc that *instructs*
  the push command while quoting the ban in the same line would slip
  through; conversely an all-caps `NEVER` alone does NOT match its
  `[Nn]ever` alternative (first letter only). Reviewers should still read
  flagged/waived lines rather than trusting the regex.
- **Reviewer focus**: confirm the `SchemaIncompleteError` message still
  contains `POSTGRES_URL` and the missing-table list (Swift dashboards and
  the nx-dbame runbook lean on that message being actionable), and that
  `packages/core/src/types/health.ts` shipped a comment-only diff.
- **Deferred, deliberately**: extending `scripts/lint-sql-safety.sh` to also
  scan for push tokens (the audit's alternative suggestion) — redundant once
  the pre-commit guard is in; and the historical push mentions in
  `packages/db/src/migrate.ts` — they document the healing logic and must
  stay.
