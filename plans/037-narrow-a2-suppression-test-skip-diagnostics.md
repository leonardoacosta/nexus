# Plan 037: Add a narrow A2 suppression entry for the 4 guarded test-skip-reason `console.log` sites

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 089e0338..HEAD -- .audit-suppressions.json`
> Expected: no output (empty diff) — the file has not changed since this plan
> was written. If it has changed, compare the "Current state" excerpt below
> against the live file before proceeding; on a real mismatch (not just a
> reordering), treat it as a STOP condition.

## Status

- **Priority**: P4
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `089e0338`, 2026-07-13

## Why this matters

`audit-scan` (the repo's read-only code-quality scanner, invoked via
`~/.claude/scripts/bin/audit-scan --project <root> --json`) flags any
`console.log` call under check ID `A2` ("debug residue") unless the file is
covered by a suppression. Four sites in this repo are `console.log` calls
that exist specifically to print a **test-skip-reason diagnostic** — a
one-line message explaining why a Postgres- or tmux-gated test block is being
skipped in the current environment. Each is already guarded by an
`// eslint-disable-next-line no-console` comment, proving it was a deliberate
choice, not an accidental leftover.

Because `A2` is the *only* debug/logging check ID missing from the
`autoSkipTestFiles` array in `.audit-suppressions.json` (every sibling
check — A3, A4, A5, A6, A7, A9, A12, and friends — already auto-skips test
files), these 4 sites resurface as findings on every future `audit-scan` run
even though they are correct as-is. Worse: **an existing committed test is
currently failing because of this gap** — see Current State below. Adding one
narrow, paths-scoped suppression entry (mirroring the existing A2 CLI-script
entry already in the file) silences this specific noise without broadening
A2 globally, which would blanket-suppress real debug-residue `console.log`
statements elsewhere — a genuine and common defect class this audit
explicitly did not clear and must not accidentally exempt.

## Current state

- `.audit-suppressions.json` (repo root) — the suppression config `audit-scan`
  reads. It has two mechanisms:
  - `suppressions`: an array of `{id, paths, reason}` stanzas — a check ID is
    suppressed only for the listed paths/globs.
  - `autoSkipTestFiles`: a flat array of check IDs that are suppressed for
    **any** test file repo-wide, no path list needed.
- The existing A2 stanza (paths-scoped, not global) looks like this today,
  lines 26–36:

  ```json
      {
        "id": "A2",
        "paths": [
          "apps/agent/src/scripts/backfill-credential-metadata.ts",
          "apps/agent/src/scripts/backfill-mcp-providers.ts",
          "apps/agent/src/scripts/import-credentials.ts",
          "apps/agent/src/scripts/probe-credential-identity.ts",
          "packages/db/src/migrate.ts"
        ],
        "reason": "CLI one-shot scripts and migration runner — console.log/error IS the intended output channel, not a leaked debug statement"
      },
  ```

  Your new stanza is a **second, separate** A2 entry (do not merge into this
  one — it targets a different reason class: test-skip diagnostics, not CLI
  scripts) using this exact shape, with this exact reason text (per the
  evidence bundle's `recommendation` field, verified against the CLI-script
  entry's wording):

  ```json
      {
        "id": "A2",
        "paths": [
          "apps/agent/src/services/process-watcher.test.ts",
          "apps/agent/src/services/process-watcher.integration.test.ts",
          "apps/agent/src/routes/health-process-watcher.test.ts"
        ],
        "reason": "console.log IS the intended output channel (test-skip-reason diagnostic), not a leaked debug statement"
      },
  ```

  Note: `paths` takes exactly 3 file paths (not 4) because two of the 4
  flagged findings are two different lines in the SAME file
  (`process-watcher.integration.test.ts:123` and `:129`) — one path entry
  suppresses both.

- `autoSkipTestFiles` (lines 154–171) currently reads:

  ```json
    "autoSkipTestFiles": [
      "A3",
      "A4",
      "A5",
      "A6",
      "A7",
      "A9",
      "A12",
      "B4",
      "D4",
      "D5",
      "D6",
      "E5",
      "E6",
      "E7",
      "F2",
      "G10"
    ]
  ```

  **Do not add `"A2"` here.** This is the whole point of the plan — a global
  test-file auto-skip for A2 would also hide a genuine leaked
  `console.log("debug:", foo)` accidentally committed in some other test
  file. Only the narrow `paths`-scoped stanza above is in scope.

- The 4 flagged sites, each confirmed live at these exact locations (re-read
  fresh against commit `089e0338`, matches the evidence bundle exactly):
  - `apps/agent/src/services/process-watcher.test.ts:186-189`:
    ```ts
    if (!hasPg) {
      // eslint-disable-next-line no-console
      console.log(
        "[process-watcher.test] POSTGRES_URL not set — skipping watcher integration tests",
      );
    }
    ```
  - `apps/agent/src/services/process-watcher.integration.test.ts:121-132`
    (two separate guarded blocks, one per environment probe):
    ```ts
    if (!TMUX_AVAILABLE) {
      // eslint-disable-next-line no-console
      console.log(
        "[process-watcher.integration.test] tmux not found on PATH — tmux flow will skip",
      );
    }
    if (!hasPg) {
      // eslint-disable-next-line no-console
      console.log(
        "[process-watcher.integration.test] POSTGRES_URL not set — skipping watcher integration",
      );
    }
    ```
  - `apps/agent/src/routes/health-process-watcher.test.ts:169-174`:
    ```ts
    if (!hasPg) {
      // eslint-disable-next-line no-console
      console.log(
        "[health-process-watcher.test] POSTGRES_URL not set — skipping reconcile-driven tests",
      );
    }
    ```
  All 4 are guarded by `eslint-disable-next-line no-console` immediately
  above the `console.log` call — the same shape as every other deliberate
  console-output site already suppressed elsewhere in this file (compare the
  existing A2/F2/A3/A4 CLI-script stanzas, which share the identical
  rationale for a different file set).

- **A pre-existing committed test is currently RED because of this exact
  gap** — this is not hypothetical, it was reproduced live before writing
  this plan:
  `packages/core/src/audit-suppressions.integration.test.ts:798-804`
  (`extend-audit-suppressions — post-suppression nx repo baseline > [2.1] A2
  finding count is zero on the nx repo`) asserts `expect(a2.length).toBe(0)`.
  Running `bun test packages/core/src/audit-suppressions.integration.test.ts`
  today reports:
  ```
  error: expect(received).toBe(expected)
  Expected: 0
  Received: 4
      at .../audit-suppressions.integration.test.ts:803:25
  ```
  Fixing this test is a **direct, intended side effect** of this plan's
  change — not a separate task. See Test plan below.

- **Important — this test file has other, unrelated, pre-existing
  failures** (18 of 43 tests fail on a clean HEAD as of this writing,
  including `E5`, `B4`, composite-score-floor, and file-path assertions
  against `apps/nextjs/...` paths that no longer exist post-reorg). **These
  are OUT OF SCOPE.** Do not investigate or fix them. Your only job is to
  make the specific A2 test (line ~798–804) go from FAIL to PASS; every
  other test's pass/fail state in this file must be unchanged by your edit
  (see Done Criteria).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Validate JSON well-formedness + suppression schema | `bash scripts/validate-audit-suppressions.sh` | exit 0, prints `validate-audit-suppressions: OK (19 entries validated)` (18 existing + 1 new) |
| Confirm A2 findings are gone | `~/.claude/scripts/bin/audit-scan --project /home/nyaptor/dev/personal/nexus --json --category quality \| python3 -c "import json,sys; d=json.load(sys.stdin); print([f for f in d['findings'] if f['id']=='A2'])"` | prints `[]` |
| Run the specific regression test this plan fixes | `bun test packages/core/src/audit-suppressions.integration.test.ts -t "A2 finding count is zero"` | `1 pass`, 0 fail |
| `db` gate (unaffected, run for hygiene) | `pnpm --filter @nexus/db typecheck` | exit 0 |
| `api` gate (unaffected, run for hygiene) | `pnpm --filter @nexus/agent typecheck` | exit 0 |
| `ui` gate (unaffected, run for hygiene) | `pnpm --filter @nexus/statusline typecheck` | exit 0 |

The `audit-scan` binary lives at `~/.claude/scripts/bin/audit-scan` (a
harness-global tool, not part of this repo). If it is missing on your
machine, `bash scripts/validate-audit-suppressions.sh` is still sufficient to
confirm the JSON edit is well-formed; the `bun test` command below also
degrades gracefully (its suite uses `describe.skipIf(!AUDIT_SCAN_AVAILABLE)`
and reports `1 skip` instead of `1 pass`/`1 fail` when the binary is absent —
that is an acceptable "cannot verify on this machine" outcome, not a failure).

## Scope

**In scope** (the only file you should modify):
- `.audit-suppressions.json` (repo root) — add exactly one new stanza to the
  `suppressions` array. Do not touch `autoSkipTestFiles`.

**Out of scope** (do NOT touch, even though they look related):
- The 4 source files themselves (`process-watcher.test.ts`,
  `process-watcher.integration.test.ts`, `health-process-watcher.test.ts`) —
  the evidence bundle confirms all 4 sites are correct as written
  (deliberate, `eslint-disable`-guarded). This plan only silences future
  audit-scan noise; it does not change any source code.
- `autoSkipTestFiles` in the same JSON file — see "Current state" above for
  why a global A2 test-file skip is explicitly wrong here.
- Any other failing test in
  `packages/core/src/audit-suppressions.integration.test.ts` besides the one
  named in "Test plan" below (E5, B4, composite-score-floor, and the
  `apps/nextjs`-path assertions are pre-existing, unrelated failures — fixing
  them is a different plan's job, if one exists; do not absorb that work
  here).
- `scripts/validate-audit-suppressions.sh` — used only to verify, never
  edited by this plan.
- Any other `.audit-suppressions.json` stanza (D4, F2, E5, C15, etc.) —
  leave every existing entry byte-for-byte unchanged except for the one new
  stanza you append.

## Git workflow

- Branch: none required — this is a single-file, single-commit ad-hoc
  change per this repo's convention (`~/.claude/rules/BEADS.md` § Session
  Close Protocol, "ad-hoc lane").
- Commit message style (conventional commits, matches recent repo history —
  see `git log --oneline -5`): something like
  `chore(audit): suppress A2 for guarded test-skip-reason console.log sites`
- Stage only `.audit-suppressions.json` (and `.beads/` if your workflow
  updates beads) — do not run `git add .` or `git add -A` in this shared
  tree.
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Add the new A2 suppression stanza

Open `.audit-suppressions.json`. Insert a new object into the
`suppressions` array, placed immediately after the existing A2 stanza
(currently ending at line 36, the CLI-scripts/migration-runner entry) so the
two A2 entries stay adjacent for readability. Use exactly this JSON (matches
the reason text mirrored from the existing A2 CLI-script entry per the
evidence bundle's recommendation):

```json
    {
      "id": "A2",
      "paths": [
        "apps/agent/src/services/process-watcher.test.ts",
        "apps/agent/src/services/process-watcher.integration.test.ts",
        "apps/agent/src/routes/health-process-watcher.test.ts"
      ],
      "reason": "console.log IS the intended output channel (test-skip-reason diagnostic), not a leaked debug statement"
    },
```

Do not forget the trailing comma on the preceding stanza's closing `}` (the
array continues with more entries after this insertion point — check the
file has valid JSON with Step 2's command before moving on).

**Verify**: `bash scripts/validate-audit-suppressions.sh` → exit 0, output
line reads `validate-audit-suppressions: OK (19 entries validated)` (one
more than the pre-change baseline of 18 — confirm the count incremented by
exactly 1).

### Step 2: Confirm the 4 A2 findings no longer surface

**Verify**:
```bash
~/.claude/scripts/bin/audit-scan --project /home/nyaptor/dev/personal/nexus --json --category quality \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print([f for f in d['findings'] if f['id']=='A2'])"
```
→ prints `[]`. If the binary is unavailable on this machine, skip this step
and rely on Step 3's test result instead (the test suite's own
`describe.skipIf` already handles that case).

### Step 3: Confirm the pre-existing regression test now passes

**Verify**:
```bash
bun test packages/core/src/audit-suppressions.integration.test.ts -t "A2 finding count is zero"
```
→ `1 pass`, `0 fail` (was `0 pass, 1 fail` before Step 1). Do not run the
whole file without the `-t` filter and interpret unrelated failures as a
regression you caused — see "Current state" above; 17 other pre-existing
failures in this file are expected and out of scope.

### Step 4: Confirm no other files changed

**Verify**: `git status --short` → shows exactly one modified file,
`.audit-suppressions.json` (plus `.beads/issues.jsonl` if your beads
workflow touched it). Nothing else.

## Test plan

No new test file is needed — a test asserting exactly this condition
**already exists**: `packages/core/src/audit-suppressions.integration.test.ts`,
test `"[2.1] A2 finding count is zero on the nx repo"` (lines 798–804). This
plan's entire job is to make that pre-existing, already-committed assertion
pass. Do not write a duplicate test.

- Verification command: `bun test packages/core/src/audit-suppressions.integration.test.ts -t "A2 finding count is zero"` → 1 pass, 0 fail.
- Do not attempt to fix the other 17 failing tests in the same file — they
  test unrelated check IDs (E5, B4) and stale `apps/nextjs` paths, and are
  explicitly out of scope for this plan (see Scope section).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bash scripts/validate-audit-suppressions.sh` exits 0 and reports 19 entries validated
- [ ] `~/.claude/scripts/bin/audit-scan --project /home/nyaptor/dev/personal/nexus --json --category quality` produces zero findings with `id == "A2"` (or this step is explicitly skipped with a note if the binary is unavailable on the executing machine)
- [ ] `bun test packages/core/src/audit-suppressions.integration.test.ts -t "A2 finding count is zero"` → 1 pass, 0 fail
- [ ] `git status --short` shows only `.audit-suppressions.json` (and optionally `.beads/issues.jsonl`) modified — no source file under `apps/agent/src/` touched
- [ ] `pnpm --filter @nexus/db typecheck`, `pnpm --filter @nexus/agent typecheck`, `pnpm --filter @nexus/statusline typecheck` all still exit 0 (unaffected by this change, run for hygiene)
- [ ] `plans/README.md` status row for plan 037 updated to DONE (unless a reviewer told you they own the index)

## STOP conditions

Stop and report back (do not improvise) if:

- `.audit-suppressions.json` at HEAD does not contain the existing A2
  CLI-script stanza shown in "Current state" (lines 26–36) — the file has
  drifted more than expected since this plan was written.
- Any of the 4 cited `console.log` sites no longer has an
  `// eslint-disable-next-line no-console` comment directly above it, or the
  surrounding `if (!hasPg)` / `if (!TMUX_AVAILABLE)` guard is gone — that
  would mean the site changed shape and the "deliberate, guarded" premise
  behind this suppression may no longer hold.
- `bash scripts/validate-audit-suppressions.sh` fails after your edit (exit
  1 or 2) — you likely introduced a JSON syntax error or a schema violation
  (missing `id`/`paths`/`reason`, or an empty array/string). Fix the syntax
  once; if it fails a second time, stop and report the exact error output.
- After Step 1, `audit-scan` (Step 2) still reports one or more A2 findings
  at any of the 4 original locations — the path string may not match
  `audit-scan`'s glob/path-matching convention (compare exactly against how
  the existing CLI-script A2 stanza's paths are written — no globs are used
  there either, so an exact relative path match is expected here too).
- The `bun test` command in Step 3 reports the named test as still failing
  after your edit, or reports a *different* pass/fail count for the file
  overall than 18 fail *(now 17, since this one flips)* / 24 pass *(now 25)*
  / 1 skip — a large unexpected shift signals your edit affected something
  beyond A2.

## Maintenance notes

- If a 5th test-skip-reason `console.log` site is added later under a
  similar pattern (a new `*.test.ts` guarded by
  `eslint-disable-next-line no-console`), add its path to this same stanza's
  `paths` array rather than creating a third A2 entry — keep the "reason:
  test-skip diagnostic" class consolidated in one stanza.
- Do not be tempted to add `"A2"` to `autoSkipTestFiles` even if more sites
  accumulate — re-read "Current state" above for why that stays wrong
  regardless of how many narrow sites exist. If the narrow-stanza approach
  ever feels like it's outgrown its purpose (e.g., dozens of sites), that is
  a judgment call for a human maintainer, not something to resolve
  unilaterally in an executor pass.
- The other 17 pre-existing failures in
  `packages/core/src/audit-suppressions.integration.test.ts` (E5, B4, stale
  `apps/nextjs` paths, composite-score floors) are real drift this plan does
  not address. If no other plan in this wave owns them, they should be
  captured as a separate beads issue by a human or a future `/improve`
  pass — do not fold that work into this plan's scope after the fact.
