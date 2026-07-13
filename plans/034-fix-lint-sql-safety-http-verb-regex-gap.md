# Plan 034: SAFE-annotate the new `integration-client.ts` HTTP-verb false positive in lint-sql-safety.sh

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 089e0338..HEAD -- apps/web/src/lib/integration-client.ts scripts/lint-sql-safety.sh`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (At planning time, both files were
> byte-identical between commit `089e0338` and the then-current HEAD
> `6796f8ab` — the diff above was empty when this plan was written.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (CI-gate hygiene)
- **Planned at**: commit `089e0338`, 2026-07-13

## Why this matters

`scripts/lint-sql-safety.sh` is the repo's CI-gating grep guard against raw
SQL string interpolation (wired as a blocking step in
`.github/workflows/ci.yml`). It currently exits 1 because of exactly one false
positive at `apps/web/src/lib/integration-client.ts:142` — an HTTP client
error-message template literal that happens to start with the SQL keyword
`DELETE`, immediately followed by `${`. This file was added by
`add-integration-registry` (commit `6b7e2a8f`), after an earlier plan
(`plans/023`, commit `5d9cb260`) had already fixed the *previous* false
positive of this kind in `elevenlabs-client.ts` — but that fix only hardened
the regex against the shape `DELETE /path -> ${status}` (keyword followed by a
literal `/`). This new site has a different shape — `` `DELETE ${path} -> ...` ``
— where the keyword is followed by a variable interpolation with no `/`
prefix at all, so the earlier hardening does not cover it. This is a genuinely
new false-positive shape, not a regression of the plans/023 fix.

While the gate is red, it cannot distinguish a real new SQL-interpolation
regression from this noise, neutralizing the guard. Note (do not act on this,
report only): the gate is currently masked in real CI by an unrelated,
pre-existing failure earlier in the pipeline (`pnpm typecheck` fails first on
the last 5 CI runs, confirmed via `gh run view`), so fixing this alone will
NOT turn CI green — that upstream failure is a separate, out-of-scope issue.
Fixing this gate is still correct: it removes latent noise that will surface
as a confusing new break the moment the upstream failure is fixed.

## Current state

Relevant files:

- `scripts/lint-sql-safety.sh` — the gate script. Pattern 1 (lines 44–58) is
  the one that matches this false positive. Do not change this file — see
  Scope below.
- `apps/web/src/lib/integration-client.ts` — browser REST client for the
  agent's generic integration-credential endpoints (`GET`/`PATCH`/`DELETE`
  `/integrations/:provider/credentials`, `POST .../test`). Line 142 is the
  false positive.
- `apps/web/src/lib/elevenlabs-client.ts` — sibling client (same shape, older,
  already fixed by plans/023). Line 155 is the exemplar to match exactly.
- `plans/README.md` — plan index; add a 034 row when done (main
  "Execution order & status" table starting at line 106 of that file, most
  recent row is `031`).

The failure, reproduced fresh at planning time:

```
$ bash scripts/lint-sql-safety.sh
VIOLATION: apps/web/src/lib/integration-client.ts:142:    throw new AgentHttpError(res.status, `DELETE ${path} -> ${res.status}`);

lint-sql-safety: found 1 violation(s)
Fix: use Drizzle query builder operators or annotate with '// SAFE: <reason>'
EXIT:1
```

The offending site (`apps/web/src/lib/integration-client.ts:129–144`):

```ts
/** `DELETE /integrations/:provider/credentials` — drop the row (204, no body). */
export async function deleteIntegrationCredentials(
  agentBaseUrl: string,
  provider: string,
  signal?: AbortSignal,
): Promise<void> {
  const path = `/integrations/${provider}/credentials`;
  const res = await request(agentBaseUrl, path, {
    method: "DELETE",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok && res.status !== 204) {
    throw new AgentHttpError(res.status, `DELETE ${path} -> ${res.status}`);
  }
}
```

Pattern 1 of the gate (`scripts/lint-sql-safety.sh:44–58`), unchanged since
plans/023 hardened it:

```bash
# Pattern 1: Untagged template literals with SQL keywords + interpolation
# Match lines containing SQL keywords inside template literals with ${} that are NOT preceded by sql`
while IFS= read -r line; do
  VIOLATIONS=$((VIOLATIONS + 1))
  echo "VIOLATION: $line"
done < <(
  grep "${GREP_OPTS[@]}" \
    -E '(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\s+(\$\{|[^/[:space:]].*\$\{)' \
    "${DIRS[@]}" 2>/dev/null \
  | grep -v '// SAFE:' \
  | grep -v 'sql`' \
  | grep -v '\.test\.' \
  | grep -v '\.spec\.' \
  || true
)
```

Why it matches: after `DELETE` and whitespace, the very next characters are
`${` — this satisfies the regex's first alternative (`\$\{`) directly,
regardless of the `/`-prefix exclusion that plans/023 added (that exclusion
only helps when the keyword is followed by a literal path like `/path`, not
when it's followed directly by a variable interpolation).

The already-fixed sibling exemplar (`apps/web/src/lib/elevenlabs-client.ts:145–158`):

```ts
export async function deleteCredentials(
  agentBaseUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await request(agentBaseUrl, "/elevenlabs/credentials", {
    method: "DELETE",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok && res.status !== 204) {
    throw new AgentHttpError(
      res.status,
      `DELETE /elevenlabs/credentials -> ${res.status}`, // SAFE: HTTP route in an error message, not SQL
    );
  }
}
```

Repo convention that applies: `// SAFE: <reason>` trailing-comment
annotations are the sanctioned exclusion mechanism (script header comment,
`scripts/lint-sql-safety.sh:3–4`). Match the exemplar's exact shape: reformat
the `throw new AgentHttpError(...)` call onto three lines (call, arg, arg)
with the `// SAFE:` comment trailing the template-literal argument line — do
not just append the comment to the existing single-line call (see Step 2 for
why).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Run the gate | `bash scripts/lint-sql-safety.sh` | `lint-sql-safety: OK (no raw SQL interpolation found)`, exit 0 |
| Gate via pnpm (CI form) | `pnpm lint:sql-safety` | same as above |
| Web typecheck (scoped) | `pnpm --filter @nexus/web typecheck` | exit 0, no output (planning-time baseline: clean, zero errors) |
| Web lint (scoped) | `pnpm --filter @nexus/web lint` | exit 0; planning-time baseline has exactly ONE pre-existing warning unrelated to this change: `apps/web/src/hooks/useMobileKeyboardBridge.ts:32:46` (`'data' is defined but never used`) — 0 errors either way |

Do not run the repo-wide `pnpm typecheck` / `pnpm lint` (`turbo typecheck` /
`turbo lint`) for this plan — plans/023's own execution log recorded a
pre-existing, unrelated `@nexus/db` bun:test-types typecheck failure at the
whole-monorepo scope, and the CI-masking `pnpm typecheck` failure noted above
is a separate, already-known, out-of-scope issue. The scoped `--filter
@nexus/web` commands above are sufficient to prove this change is clean and
avoid tripping on either unrelated failure.

## Scope

**In scope** (the only file you should modify, besides the plan index):

- `apps/web/src/lib/integration-client.ts` — reformat the single `throw new
  AgentHttpError(...)` call at line 142 to three lines and add ONE trailing
  `// SAFE:` comment. No other edit in this file.
- `plans/README.md` — add a 034 status row to the "Execution order & status"
  table (most recent existing row is `031`, at/around line 116).

**Out of scope** (do NOT touch, even though they look related):

- `scripts/lint-sql-safety.sh` — the regex itself. The recommended approach
  for this plan is the SAFE-annotation route specifically because it carries
  zero risk of loosening the gate for a future real SQL site; widening the
  regex further is a deliberately rejected alternative for this plan (see
  Maintenance notes for why, and what a future widening attempt should be
  careful of).
- `packages/db/src/schema/*.ts` and any other raw-SQL site in `apps/agent` —
  all reconfirmed clean this wave; not part of this false positive.
- `apps/web/src/lib/elevenlabs-client.ts` — already correctly annotated by
  plans/023; it is the exemplar to match, not a file to edit.
- `.github/workflows/ci.yml` — the CI wiring is correct; the pre-existing
  `pnpm typecheck` failure that masks this gate in real CI is a separate,
  already-known issue (do not investigate or fix it — report only, per the
  "Why this matters" note above).
- Any other line in `integration-client.ts` besides line 142 — in particular,
  do not "fix" the similarly-shaped `GET`/`PATCH` error strings at lines 86
  and 105/126 (`` `${path} -> ${res.status}${detail}` ``, `` `GET ${path}` ``)
  — none of them start with a SQL keyword (`GET`/`PATCH` are not in the
  gate's keyword alternation), so they do not trip the gate and need no
  annotation. Confirm this yourself in Step 1 (the baseline shows exactly one
  violation) before touching anything.

## Git workflow

- This repo's plans execute in worktrees, but Leo also works directly on
  `main` in `~/dev/personal/nexus` — expect `main` to advance mid-execution.
  Work on the current branch of your worktree; if you are in a worktree,
  complete any merge-back to `main` per the repo's normal flow.
- Single commit, targeted adds only (never `git add .`):
  `git add apps/web/src/lib/integration-client.ts plans/README.md`
  (plus `.beads/` if the pre-commit hook stages it).
- Conventional-commit message; write it to a file and use `git commit -F`
  (never a HEREDOC chained with `&&`). Suggested:
  `fix(lint): SAFE-annotate integration-client.ts HTTP-verb false positive`
- Include in the commit body (not just chat) the note that this gate is
  currently masked in real CI by an unrelated pre-existing `pnpm typecheck`
  failure — fixing this alone will not turn CI green.
- Do not push unless explicitly instructed by whoever dispatched you.

## Steps

### Step 1: Reproduce the red baseline

Run the gate before changing anything.

**Verify**: `bash scripts/lint-sql-safety.sh; echo "EXIT=$?"` →
exactly ONE `VIOLATION:` line, citing
`apps/web/src/lib/integration-client.ts:142`, then
`lint-sql-safety: found 1 violation(s)` and `EXIT=1`.
If the violation count differs, or it cites a different file/line, or there
is more than one violation, STOP (the codebase has drifted from this plan's
premise).

### Step 2: Reformat and SAFE-annotate line 142

Edit `apps/web/src/lib/integration-client.ts`. Change:

```ts
  if (!res.ok && res.status !== 204) {
    throw new AgentHttpError(res.status, `DELETE ${path} -> ${res.status}`);
  }
```

to:

```ts
  if (!res.ok && res.status !== 204) {
    throw new AgentHttpError(
      res.status,
      `DELETE ${path} -> ${res.status}`, // SAFE: HTTP route in an error message, not SQL
    );
  }
```

Use the multi-line shape (call / arg / arg), matching
`elevenlabs-client.ts:153–156` exactly — do not simply append the comment to
the existing single-line call. Reasons: (a) it matches the established
sibling-file convention so the two near-identical clients read identically at
their one annotated site, and (b) the gate's grep match is line-based, so the
comment must land on the physical line containing the `DELETE ${path}`
template literal for the `grep -v '// SAFE:'` filter to exclude it — putting
it on its own argument line, as here, satisfies that directly.

**Verify**: `bash scripts/lint-sql-safety.sh; echo "EXIT=$?"` →
`lint-sql-safety: OK (no raw SQL interpolation found)` and `EXIT=0`.

### Step 3: Run the scoped local quality gates

```bash
pnpm --filter @nexus/web typecheck
pnpm --filter @nexus/web lint
```

**Verify**: both commands exit 0. `typecheck` prints nothing (planning-time
baseline is a silent clean pass). `lint` prints at most the one pre-existing
`useMobileKeyboardBridge.ts` warning noted in "Commands you will need" — 0
errors either way. Neither command should reference
`integration-client.ts` at all (a reformatted call plus a trailing comment is
invisible to both `tsc` and `eslint`'s rule set here). If either command
reports an error that DOES reference `integration-client.ts`, STOP.

### Step 4: Update the plan index

Add a row for 034 to the "Execution order & status" table in
`plans/README.md` (the table's most recent row at planning time is `031`),
matching the existing column format (`| Plan | Title | Priority | Effort |
Depends on | Status |`):

```
| 034 | SAFE-annotate integration-client.ts HTTP-verb false positive in lint-sql-safety.sh | P2 | S | — | DONE (lint-sql-safety exit 0; web typecheck clean; web lint 0 errors/1 pre-existing warning) spec-impact: none |
```

(If this work turns out to affect an OpenSpec capability, name it instead of
`none` — at planning time no spec is impacted: the change is one comment plus
a reformat.)

**Verify**: `grep -n '^| 034' plans/README.md` → the row exists with a
terminal status.

### Step 5: Commit

Write the commit message to a file first (RTK HEREDOC footgun — never chain a
HEREDOC with `&&`):

```bash
# Write via your Write tool to /tmp/commit-msg-plan034.txt, then:
git add apps/web/src/lib/integration-client.ts plans/README.md
git commit -F /tmp/commit-msg-plan034.txt
```

**Verify**: `git log --oneline -1` shows your commit; `git status` shows no
modifications to files outside the in-scope list (pre-commit-hook-staged
`.beads/` files are expected and fine).

## Test plan

- **No new committed test file.** Rationale, matching plans/023's precedent
  for the same file family: `integration-client.ts` has no dedicated test
  file (confirmed: `apps/web/src/lib/*.test.ts` contains only
  `agent-rest-client.test.ts` and `agent-radar-client.test.ts`), the change is
  a comment-only reformat with no new logic to unit-test, and a committed
  fixture containing SQL-injection shapes under `apps/` would itself trip the
  gate it's meant to test. The gate itself (`bash scripts/lint-sql-safety.sh`,
  wired as a blocking CI step) is the standing regression harness.
- Existing coverage exercised: the scoped `pnpm --filter @nexus/web
  typecheck` / `lint` commands in Step 3 are the structural pattern to mimic
  for "did this comment-only change break anything" — same commands, same
  scoping, as used in plans/023's Step 5 for the sibling file.
- Verification: `bash scripts/lint-sql-safety.sh; echo "EXIT=$?"` → `EXIT=0`,
  is the primary pass/fail signal for this plan.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bash scripts/lint-sql-safety.sh` exits 0 with
      `lint-sql-safety: OK (no raw SQL interpolation found)`.
- [ ] `grep -c 'SAFE: HTTP route' apps/web/src/lib/integration-client.ts` → `1`.
- [ ] `pnpm --filter @nexus/web typecheck` exits 0.
- [ ] `pnpm --filter @nexus/web lint` exits 0 (0 errors; the one pre-existing
      `useMobileKeyboardBridge.ts` warning, if still present, does not count
      against this).
- [ ] `git status` shows no modifications outside
      `apps/web/src/lib/integration-client.ts`, `plans/README.md`, and any
      pre-commit-hook-staged `.beads/` files.
- [ ] `plans/README.md` has a `034` row with a terminal status.

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 shows anything other than exactly one violation at
  `apps/web/src/lib/integration-client.ts:142` (someone fixed or moved it
  already, or a second genuine violation landed — either way this plan's
  premise drifted).
- Step 2's annotation does not turn the gate green (the `// SAFE:` filter
  behaved unexpectedly — compare byte-for-byte against the
  `elevenlabs-client.ts:155` exemplar; a stray character, e.g. wrong comment
  marker or the comment landing on the wrong physical line, is the most
  likely cause).
- `pnpm --filter @nexus/web typecheck` or `pnpm --filter @nexus/web lint`
  fails with an error (not a pre-existing warning) that references
  `integration-client.ts`.
- Fixing anything appears to require touching `scripts/lint-sql-safety.sh`,
  any `packages/db/src/schema/*.ts` file, or any other raw-SQL site in
  `apps/agent` — those are explicitly out of scope for this plan.
- `git commit` fails, or the pre-commit hook rejects the commit for a reason
  unrelated to this change.

## Maintenance notes

- **Why the SAFE-annotation route was chosen over widening the regex**: a
  regex fix that stops matching "keyword directly followed by `${`" would
  also stop catching a genuine SQL injection shape like
  `` `DELETE ${table}` `` (a real, if contrived, vulnerable pattern) — the
  keyword-adjacent-to-`${}` shape IS exactly what Pattern 1 exists to catch.
  Loosening it further than the plans/023 `/`-prefix exclusion risks
  widening the gate's blind spot for a real future site. The SAFE annotation
  carries no such risk: it excludes exactly one reviewed line, is a repo-wide
  established convention (8+ existing sites across plans/006 and plans/023),
  and needs no regex reasoning to re-verify later.
- **This class will keep recurring** on new HTTP clients that follow the
  `deleteXxxCredentials` pattern (any client whose error string embeds the
  literal HTTP verb `DELETE` immediately before a `${...}` interpolation).
  The next occurrence will need the same one-line SAFE annotation — there is
  no code-level fix that prevents it without touching the out-of-scope regex
  (see previous bullet).
- **What a reviewer should scrutinize**: that the diff to
  `integration-client.ts` is exactly the three-line reformat plus the
  trailing comment (no logic change — the thrown error message and status
  code are byte-identical to before), and that the plans/README.md row was
  actually added, not skipped.
- **Explicitly deferred, not fixed by this plan**: the CI-masking
  `pnpm typecheck` failure (confirmed via `gh run view` on the last 5 CI
  runs, all failing before the `lint:sql-safety` step is ever reached). This
  plan's gate fix is necessary but not sufficient for CI to go green — that
  separate failure needs its own plan.
