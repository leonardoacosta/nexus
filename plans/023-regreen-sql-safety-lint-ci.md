# Plan 023: Re-green lint-sql-safety and unbreak the CI gate (SAFE annotation + HTTP-verb regex hardening)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. When you mark the row DONE/BLOCKED/REJECTED you MUST
> append `spec-impact: <slug>[, ...]` or `spec-impact: none` to the row.
>
> **Drift check (run first)**:
> `git diff --stat b7096486..HEAD -- scripts/lint-sql-safety.sh apps/web/src/lib/elevenlabs-client.ts`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (At planning time both files were
> byte-identical between `b7096486` and the then-current HEAD `d458ef8e` —
> the diff above was empty.)

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (broken quality gate) / dx
- **Planned at**: commit `b7096486`, 2026-07-11

## Why this matters

`scripts/lint-sql-safety.sh` is the repo's grep guard against raw SQL string
interpolation. It has been RED since 2026-07-05 (commit `ad6b2161`) because of a
single false positive: an HTTP error-message template literal in
`apps/web/src/lib/elevenlabs-client.ts` that happens to start with the word
`DELETE` — an HTTP verb, not SQL. While the gate is red it cannot distinguish a
genuine new SQL-interpolation regression from this noise, which neutralizes the
guard entirely. The gate is wired as a blocking CI step
(`.github/workflows/ci.yml:62` runs `pnpm lint:sql-safety`), so this false
positive would fail every CI run on main the moment CI reaches that step.

Two fixes land together: (a) a `// SAFE:` annotation at the offending line
(immediate re-green, documents intent at the site), and (b) a hardening of the
lint's Pattern 1 regex so the whole class of `` `VERB /path -> ${status}` ``
HTTP strings stops matching. (b) matters because `apps/web` keeps producing
this exact shape — e.g. `apps/web/src/lib/agent-rest-client.ts:141` already has
`` `GET /sessions -> ${res.status}` `` (harmless today only because GET is not
a SQL keyword; the next DELETE-route client will trip the gate again without
the hardening).

**IMPORTANT planning-time discovery (adjusts the CI expectation)**: at planning
time, CI on main was failing at an EARLIER step — "Apply DB schema"
(`pnpm --filter @nexus/db db:migrate` against the throwaway CI Postgres fails
with `PostgresError: column "value_plaintext" of relation "credentials" does
not exist`, code `42703`, routine `ATExecDropColumn`). Every run from at least
2026-07-08 (`28919322387`) through 2026-07-12 (`29174450052`) fails at that
step, so `pnpm lint:sql-safety` is currently never reached in CI. That upstream
failure is explicitly OUT OF SCOPE for this plan (report it, do not fix it —
migrations are governed by the repo's migration-only policy and need their own
plan). This plan's CI done-criterion is therefore conditional: the
`lint:sql-safety` step must be green IF the run reaches it; if the run still
dies at "Apply DB schema", the local exit-0 evidence plus a report of the
upstream failure completes this plan.

## Current state

Relevant files:

- `scripts/lint-sql-safety.sh` — the gate. Three grep patterns; Pattern 1
  (lines 42–56) is the one that false-positives.
- `apps/web/src/lib/elevenlabs-client.ts` — typed client for the agent's
  ElevenLabs routes; line 155 is the false positive.
- `.github/workflows/ci.yml` — line 62 runs the gate as a blocking step
  (`- run: pnpm lint:sql-safety`). Root `package.json` line 11 maps
  `"lint:sql-safety": "./scripts/lint-sql-safety.sh"`.
- `plans/README.md` — plan index; add/update the 023 row when done.

The failure, reproduced fresh at planning time:

```
$ bash scripts/lint-sql-safety.sh
VIOLATION: apps/web/src/lib/elevenlabs-client.ts:155:      `DELETE /elevenlabs/credentials -> ${res.status}`,

lint-sql-safety: found 1 violation(s)
Fix: use Drizzle query builder operators or annotate with '// SAFE: <reason>'
EXIT=1
```

The offending site (`apps/web/src/lib/elevenlabs-client.ts:152-158`):

```ts
  if (!res.ok && res.status !== 204) {
    throw new AgentHttpError(
      res.status,
      `DELETE /elevenlabs/credentials -> ${res.status}`,
    );
  }
}
```

Pattern 1 of the gate (`scripts/lint-sql-safety.sh:42-56`):

```bash
# Pattern 1: Untagged template literals with SQL keywords + interpolation
# Match lines containing SQL keywords inside template literals with ${} that are NOT preceded by sql`
while IFS= read -r line; do
  VIOLATIONS=$((VIOLATIONS + 1))
  echo "VIOLATION: $line"
done < <(
  grep "${GREP_OPTS[@]}" \
    -E '(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\s.*\$\{' \
    "${DIRS[@]}" 2>/dev/null \
  | grep -v '// SAFE:' \
  | grep -v 'sql`' \
  | grep -v '\.test\.' \
  | grep -v '\.spec\.' \
  || true
)
```

Repo conventions that apply:

- `// SAFE: <reason>` trailing-comment annotations are the sanctioned exclusion
  mechanism (script header, lines 2–5). Seven such annotations exist from plan
  006 — exemplar: `apps/agent/src/testing/isolated-pg-schema.ts:80`:
  ```ts
  await adminSql.unsafe(`CREATE SCHEMA "${schema}"`); // SAFE: schema is a test-only generated name (nx_<label>_<ts>_<rand>, line 73), never request data
  ```
  Match that style: trailing `// SAFE:` + a concrete reason.
- The script already uses `\s` inside `grep -E` (a GNU grep extension) — the
  hardened regex may keep using it; CI runs ubuntu GNU grep.
- Commit style is conventional commits, e.g. recent history:
  `fix(credentials): stop credential-usage-poller's 100% failure rate`.

The hardened regex, designed and empirically validated at planning time:

```
OLD: (SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\s.*\$\{
NEW: (SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\s+(\$\{|[^/[:space:]].*\$\{)
```

Semantics of NEW: after the keyword and whitespespace, the next character must
either start an interpolation directly (`${` — catches `` `UPDATE ${table}` ``)
or be a non-slash, non-space character (catches `` `DELETE FROM ... ${id}` ``).
A keyword whose first following token starts with `/` — the HTTP-route shape
`DELETE /elevenlabs/credentials -> ${res.status}` — no longer matches, even
with multiple spaces before the `/`. Validation results from planning time
(reproduce in Step 3):

- Fixture with 11 lines: NEW excludes the 2 HTTP-verb shapes
  (`` `DELETE /path -> ${x}` `` and a two-space variant) and retains all 7
  true-positive SQL shapes (`DELETE FROM`, `SELECT *`, `UPDATE ${t}`,
  `INSERT INTO`, `DROP TABLE`, `TRUNCATE ${t}`, `CREATE INDEX`).
- Against the live repo, the full Pattern-1 pipeline with NEW produced zero
  unannotated hits, and with the `// SAFE:` filter removed still detected
  exactly 7 annotated sites — detection power on real code is preserved.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Run the gate | `bash scripts/lint-sql-safety.sh` | `lint-sql-safety: OK (no raw SQL interpolation found)`, exit 0 |
| Gate via pnpm (CI form) | `pnpm lint:sql-safety` | same as above |
| Typecheck | `pnpm typecheck` | exit 0 (see Step 5 caveat on pre-existing failures) |
| Web lib tests | `bun test apps/web/src/lib` | `18 pass, 0 fail` (2 files) — planning-time baseline |
| Lint | `pnpm lint` | exit 0 |
| CI watch | `gh run watch <run-id> --repo leonardoacosta/nexus --exit-status` | see Step 7 |
| CI list | `gh run list --repo leonardoacosta/nexus --branch main --limit 3` | newest run visible |

Test env note: full-suite `bun test` needs `NEXUS_ATTACH_SECRET=test` (and
`POSTGRES_URL` for PG integration tests). Step 5 only requires the scoped
`apps/web/src/lib` run, which needs neither.

## Scope

**In scope** (the only files you should modify):

- `apps/web/src/lib/elevenlabs-client.ts` — ONE trailing comment on line 155.
  No other edit in this file.
- `scripts/lint-sql-safety.sh` — Pattern 1 regex (line 49) + the explanatory
  comment block above it. No change to Patterns 2 and 3, the SAFE/sql`/test
  filters, GREP_OPTS, or exit-code behavior.
- `plans/README.md` — add/update the 023 status row (no 023 row exists yet).

**Out of scope** (do NOT touch, even though they look related):

- `.github/workflows/ci.yml` — including its stale line-14 comment
  ("red until plans/006 ... merges"); the workflow itself is plan 013's file.
- `packages/db/**` (migrations, `src/migrate.ts`) — the "Apply DB schema" CI
  failure lives here. Migration-only policy applies (`db:generate` +
  `db:migrate`, NEVER `db:push`); fixing it is a separate plan. Report only.
- The seven existing `// SAFE:` annotations from plan 006 (e.g.
  `apps/agent/src/services/process-watcher.ts:911`,
  `packages/db/src/migrate.ts:114-196`) — already correct, still detected.
- `apps/web/src/lib/agent-rest-client.ts` — its `` `GET /sessions -> ${...}` ``
  strings never matched (GET is not in the keyword alternation); they need no
  annotation.
- Any other CI step that fails once (or before) sql-safety greens — per this
  plan's ownership boundary: report, do not fix.

## Git workflow

- This repo's plans execute in worktrees, but Leo also works directly on
  `main` in `~/dev/personal/nexus` — expect main to advance mid-execution.
  Work on the current branch of your worktree; if you are in a worktree,
  complete the merge-back to main BEFORE Step 7 (the CI check requires the
  commit to be on main).
- Single commit, targeted adds only (never `git add .`):
  `git add apps/web/src/lib/elevenlabs-client.ts scripts/lint-sql-safety.sh plans/README.md`
  (plus `.beads/` if the pre-commit hook stages it).
- Conventional-commit message; write it to a file and use `git commit -F`
  (never a HEREDOC chained with `&&`). Suggested:
  `fix(lint): re-green sql-safety gate — SAFE-annotate HTTP error string, harden Pattern 1 regex`
- Push IS instructed for this plan (the CI verification requires it): push as
  a separate command after the commit.

## Steps

### Step 1: Reproduce the red baseline

Run the gate before changing anything.

**Verify**: `bash scripts/lint-sql-safety.sh; echo "EXIT=$?"` →
exactly ONE `VIOLATION:` line, citing
`apps/web/src/lib/elevenlabs-client.ts:155`, then
`lint-sql-safety: found 1 violation(s)` and `EXIT=1`.
If the violation count differs or cites a different file/line, STOP (drift).

### Step 2: Add the SAFE annotation at elevenlabs-client.ts:155

Edit `apps/web/src/lib/elevenlabs-client.ts` line 155 from:

```ts
      `DELETE /elevenlabs/credentials -> ${res.status}`,
```

to:

```ts
      `DELETE /elevenlabs/credentials -> ${res.status}`, // SAFE: HTTP route in an error message, not SQL
```

One line, trailing comment only, matching the plan-006 annotation style.

**Verify**: `bash scripts/lint-sql-safety.sh; echo "EXIT=$?"` →
`lint-sql-safety: OK (no raw SQL interpolation found)` and `EXIT=0`.

### Step 3: Harden the Pattern 1 regex against HTTP-verb template literals

In `scripts/lint-sql-safety.sh`, change line 49 from:

```bash
    -E '(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\s.*\$\{' \
```

to:

```bash
    -E '(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\s+(\$\{|[^/[:space:]].*\$\{)' \
```

And extend the script's "Exclude:" comment block (currently lines 27–30) with
one new bullet so the next reader knows why, e.g.:

```bash
#   - Keyword followed by "/" (HTTP-verb route strings like `DELETE /path -> ${status}`,
#     not SQL — SQL DELETE is "DELETE FROM"; see plans/023)
```

Do not alter Patterns 2 and 3, the filter greps, or anything else.

**Verify**: `bash scripts/lint-sql-safety.sh; echo "EXIT=$?"` →
`lint-sql-safety: OK (no raw SQL interpolation found)` and `EXIT=0`.

### Step 4: Prove the hardened regex keeps its detection power (ephemeral fixture)

Create a fixture OUTSIDE the repo (never under `apps/` or `packages/` — a
committed fixture would itself trip the gate). Use `/tmp` or your scratchpad:

```bash
cat > /tmp/plan023-regex-fixture.txt <<'EOF'
      `DELETE /elevenlabs/credentials -> ${res.status}`,
  const q5 = `DELETE  /two-spaces/path -> ${res.status}`;
  const q = `DELETE FROM users WHERE id = ${id}`;
  const q2 = `SELECT * FROM ${table}`;
  const q3 = `UPDATE ${table} SET x = 1`;
  const q4 = `INSERT INTO logs VALUES (${v})`;
  const q6 = `DROP TABLE ${t}`;
  const q7 = `TRUNCATE ${t}`;
  const q8 = `CREATE INDEX idx ON t (${col})`;
EOF
NEW='(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\s+(\$\{|[^/[:space:]].*\$\{)'
grep -cE "$NEW" /tmp/plan023-regex-fixture.txt
```

**Verify (a)**: the `grep -c` prints `7` — the two HTTP-verb lines (lines 1–2
of the fixture) are excluded, all seven SQL shapes still match. Any other
number is a STOP condition.

**Verify (b)** — in-repo detection power unchanged (the 7 plan-006 annotated
sites are still caught by the regex before the SAFE filter):

```bash
grep -rn --include='*.ts' --include='*.tsx' --include='*.js' \
  --exclude-dir='.next' --exclude-dir='dist' --exclude-dir='node_modules' \
  --exclude-dir='.turbo' --exclude-dir='coverage' \
  -E "$NEW" apps packages 2>/dev/null \
  | grep -v 'sql`' | grep -v '\.test\.' | grep -v '\.spec\.' \
  | grep -c '// SAFE:'
```

→ prints `8` (the 7 pre-existing plan-006 annotations + the new one from
Step 2). If it prints less than 8, the hardened regex lost detection of a real
SQL shape — STOP.

### Step 5: Run the local quality gates

```bash
pnpm typecheck
pnpm lint
bun test apps/web/src/lib
```

**Verify**: `bun test apps/web/src/lib` → `18 pass, 0 fail` (planning-time
baseline; more is fine if main advanced). `pnpm typecheck` and `pnpm lint` →
exit 0 expected; if either fails, the failure must NOT reference
`elevenlabs-client.ts` or otherwise be attributable to the two changed files
(a trailing comment and a bash script are invisible to tsc/eslint). Any
pre-existing unrelated failure: note it in your report, do not fix it, proceed.
A failure that DOES reference a changed file is a STOP condition.

### Step 6: Commit and push

Write the commit message to a file first (RTK HEREDOC footgun — never chain a
HEREDOC with `&&`):

```bash
# Write via your Write tool to /tmp/commit-msg-plan023.txt:
#   fix(lint): re-green sql-safety gate — SAFE-annotate HTTP error string, harden Pattern 1 regex
git add apps/web/src/lib/elevenlabs-client.ts scripts/lint-sql-safety.sh plans/README.md
git commit -F /tmp/commit-msg-plan023.txt
git push
```

(If executing in a worktree: merge back to main via the repo's merge-back flow
first; the push that matters is the one that lands the commit on `main`.)

**Verify**: `git log --oneline -1` shows your commit; `git push` exited 0;
`git status` shows no modifications to files outside the in-scope list
(pre-commit-hook-staged `.beads/` files are expected and fine).

### Step 7: Watch the CI run on main

```bash
gh run list --repo leonardoacosta/nexus --branch main --limit 1
gh run watch <run-id> --repo leonardoacosta/nexus --exit-status
```

Paste the final step list into your report. Expected outcomes, in order of
likelihood at planning time:

- **Outcome A (likely)**: the run fails at `Apply DB schema` — the
  pre-existing, out-of-scope migration-replay failure
  (`PostgresError: column "value_plaintext" of relation "credentials" does not
  exist`, code 42703; failing every main run since at least 2026-07-08,
  runs `28919322387` → `29174450052`). The `Run pnpm lint:sql-safety` step is
  never reached. This plan is then COMPLETE on its local evidence (Steps 1–6):
  record status DONE with a note that CI-green is blocked upstream by the
  db:migrate failure, and report that failure explicitly so it gets its own
  plan. Do NOT attempt to fix it.
- **Outcome B**: the run reaches `Run pnpm lint:sql-safety` and that step is
  green (✓). If every step is green, paste the all-green run — full success.
  If a LATER step fails (typecheck/lint/test), same rule: sql-safety green is
  this plan's proof; report the other failure, do not fix.
- **Outcome C (STOP)**: the run fails AT `Run pnpm lint:sql-safety`. The fix
  did not work in CI — STOP and report with the CI log excerpt.

### Step 8: Update the plan index

Add a row for 023 to the execution-order table in `plans/README.md` (no row
exists yet — the table currently ends at 022), matching the existing format:

```
| 023 | Re-green lint-sql-safety (SAFE annotation + HTTP-verb regex hardening) | P1 | S | — | DONE (<branch>; lint-sql-safety exit 0; fixture 7/7 + repo 8 SAFE detected; CI: <outcome A/B per Step 7>) spec-impact: none |
```

(If this work turns out to affect an OpenSpec capability, name it instead of
`none` — at planning time no spec is impacted: the change is a lint script +
one comment.)

**Verify**: `grep -n '^| 023' plans/README.md` → the row exists with a
terminal status and a `spec-impact:` marker.

## Test plan

- **No new committed test file.** Rationale: the deliverable is a bash lint
  gate plus a comment-only TS edit; the repo has no shell-script test harness,
  and a committed fixture containing SQL-injection shapes under `apps/` or
  `packages/` would trip the gate it tests. The gate itself runs as a blocking
  CI step on every push (`.github/workflows/ci.yml:62`) — that is the
  standing regression harness for this change.
- The detection-power proof is Step 4's ephemeral fixture (7 true positives
  retained, 2 HTTP-verb shapes excluded) plus the in-repo count of 8
  SAFE-annotated matches. These substitute for a unit test and MUST be run.
- Existing tests exercised: `bun test apps/web/src/lib` (colocated bun:test
  suites `agent-rest-client.test.ts` + `agent-radar-client.test.ts`, the
  module family the annotated file belongs to) → 18 pass at baseline. No test
  file exists for `elevenlabs-client.ts`; do not create one (out of scope).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bash scripts/lint-sql-safety.sh` exits 0 with `lint-sql-safety: OK`.
- [ ] `grep -c 'SAFE: HTTP route' apps/web/src/lib/elevenlabs-client.ts` → `1`.
- [ ] `grep -c '\[\^/\[:space:\]\]' scripts/lint-sql-safety.sh` → `1` (hardened
      regex present in Pattern 1).
- [ ] Step 4 fixture grep prints `7`; in-repo SAFE-annotated match count is `8`.
- [ ] `bun test apps/web/src/lib` → 0 fail.
- [ ] `pnpm typecheck` / `pnpm lint`: no failure referencing a changed file.
- [ ] Commit is on `main` (pushed); `git status` clean of out-of-scope edits.
- [ ] CI: per Step 7 — either the run is green end-to-end, or the
      `Run pnpm lint:sql-safety` step is green, or the run fails strictly
      BEFORE that step at the documented `Apply DB schema` failure (Outcome A)
      and that upstream failure is reported in the status row / report.
- [ ] `plans/README.md` has a 023 row with terminal status + `spec-impact:`.

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 shows anything other than exactly one violation at
  `apps/web/src/lib/elevenlabs-client.ts:155` (someone fixed or moved it, or a
  second genuine violation landed — either way this plan's premise drifted).
- Step 2's annotation does not turn the gate green (the `// SAFE:` filter
  behaved unexpectedly).
- Step 4(a) prints anything other than `7`, or Step 4(b) prints less than `8`
  — the hardened regex changed detection power in an unplanned way.
- `pnpm typecheck` or `pnpm lint` fails with an error referencing
  `elevenlabs-client.ts` or any changed file.
- `git push` (or the worktree merge-back to main) fails 3 times.
- CI fails AT the `Run pnpm lint:sql-safety` step after your commit (Outcome C).
- Fixing anything appears to require touching an out-of-scope file — in
  particular anything under `packages/db/` for the "Apply DB schema" failure.

## Maintenance notes

- **The Step 2 annotation is deliberately redundant after Step 3.** Once the
  regex is hardened, the annotated line no longer matches Pattern 1 at all.
  Keep the annotation anyway: it documents intent at the site and keeps the
  gate green if the regex is ever reverted or re-widened. A reviewer should
  not flag it as dead.
- **Known accepted regex gap**: a SQL template with a comment straight after
  the keyword (`` `DELETE /* audit */ FROM ${t}` ``) starts with `/` and would
  now be excluded. No such shape exists in the repo; the `// SAFE:` review
  convention and code review remain the backstop. If this shape ever appears,
  tighten the exclusion to `/[^*]` at that time.
- **The class will recur on new HTTP verbs only if they collide with SQL
  keywords.** GET/POST/PUT/PATCH never matched; DELETE was the only collision.
  Prose-style `UPDATE /path` or `CREATE /path` strings are also excluded now.
- **Upstream CI failure to hand off**: the `Apply DB schema` step
  (`pnpm --filter @nexus/db db:migrate` on a fresh Postgres) fails with
  `column "value_plaintext" of relation "credentials" does not exist` (42703,
  `ATExecDropColumn`) — a migration in `packages/db/drizzle/` drops a column
  that never exists on clean replay. Failing every main CI run since at least
  2026-07-08. Needs its own plan under the migration-only policy; until it
  lands, CI cannot go green regardless of this plan.
- **What a reviewer should scrutinize**: that line 49 is the ONLY functional
  change in the script (diff should show one regex line + comment lines), and
  that the fixture verification (Step 4) was actually run, not skipped.
