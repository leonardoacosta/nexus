# Re-green the SQL-safety lint gate and stop the banned db:push instruction from reproducing

## Why

Two quality-gate defects verified by the Wave-3 `/improve:code` audit (2026-07-11, commit
`b7096486`), bundled because both are small P1/P2 gate-hardening fixes with no shared files:

1. **`scripts/lint-sql-safety.sh` is RED** since 2026-07-05 (`ad6b2161`) on a false positive: an
   HTTP error-message template literal in `apps/web/src/lib/elevenlabs-client.ts` starts with the
   word `DELETE` (an HTTP verb, not SQL). The gate is wired as a blocking CI step
   (`.github/workflows/ci.yml:62`), so while it's red it cannot distinguish a genuine new
   SQL-interpolation regression from this noise — the guard is neutralized. The false-positive
   shape (`` `VERB /path -> ${status}` ``) already recurs elsewhere in `apps/web` and will trip
   again on the next DELETE-route client.
2. **The agent's `SchemaIncompleteError` instructs the operator to run the banned `db:push`
   command** — the exact command this repo prohibited after the nx-vtzmd incident (2026-06-20:
   `db:push` skips the migrations journal, can silently drop columns, and collides with the
   deploy's `db:migrate` replay). Worse, `db:push` isn't even a script in
   `packages/db/package.json` anymore, so the instruction's first form fails outright and pushes
   the operator toward the parenthetical `drizzle-kit push`, which DOES work and replays the
   incident against the shared homelab DB. Three sibling prose sites carry the same stale
   instruction, and nothing currently catches a future reintroduction.

## What Changes

- **SQL-safety gate**: annotate the one false-positive site with `// SAFE: <reason>` (immediate
  re-green) and harden Pattern 1's regex so the `VERB /path -> ${status}` shape stops matching
  generally, while all 7 existing true-positive `// SAFE:` sites remain detected.
- **db:push operator guidance**: rewrite `SchemaIncompleteError`'s remediation sentence (and its
  pinned test) to instruct `db:migrate`; fix the three sibling prose sites
  (`docker-compose.test.yml`, `sessions.test.ts` doc-comment, `health.ts` docstring) that still
  reference the banned command.
- **db:push pre-commit guard**: install `scripts/hooks/pre-commit-block-db-push.sh` (rejects any
  staged diff line that re-introduces `db:push`/`drizzle-kit push` without a negation marker) and
  wire it into `.beads/hooks/pre-commit` after the beads-managed block, so the class cannot be
  silently reintroduced again.

## Context

- touches: `scripts/lint-sql-safety.sh`, `apps/web/src/lib/elevenlabs-client.ts`,
  `apps/agent/src/db/database.ts`, `apps/agent/src/db/database.test.ts`,
  `docker-compose.test.yml`, `apps/agent/src/routes/sessions.test.ts`,
  `packages/core/src/types/health.ts`, `scripts/hooks/pre-commit-block-db-push.sh`,
  `.beads/hooks/pre-commit`

No soft dependencies: neither plan touches a file any other in-flight proposal writes.
`ios-session-navigation` (the only other unarchived proposal) is Swift/iOS-only.

**Known upstream blocker (out of scope, report only)**: CI on main has been failing at an
*earlier* step — `Apply DB schema` (`pnpm --filter @nexus/db db:migrate` against a fresh Postgres
fails with `column "value_plaintext" of relation "credentials" does not exist`, 42703) — since at
least 2026-07-08. Until that migration-replay defect is fixed separately, CI never reaches the
`lint:sql-safety` step this change repairs. This change's done-criteria account for that: local
exit-0 evidence is sufficient; CI green end-to-end is not required.

**Source material**: this proposal transcribes two already-detailed advisor executor briefs —
`plans/023-regreen-sql-safety-lint-ci.md` and `plans/024-fix-dbpush-operator-instruction.md` — into
OpenSpec/beads-tracked form so they run through `/apply` instead of ad-hoc branch execution. Every
step, verification command, and STOP condition in those files remains authoritative; `tasks.md`
here summarizes them at checkbox granularity.

## Testing

- **`scripts/lint-sql-safety.sh`**: no new committed test file (a committed SQL-injection fixture
  would itself trip the gate it tests) — the ephemeral-fixture regex-power proof
  (plans/023 Step 4: 7 true positives retained, 2 HTTP-verb shapes excluded) plus the gate's own
  green exit substitute for a unit test, and the gate running as a blocking CI step is the standing
  regression harness.
- **`SchemaIncompleteError`**: new PG-free unit test in `database.test.ts` pinning the message
  contains `pnpm --filter @nexus/db db:migrate` and never `db:push`/`drizzle-kit push`
  (nx-vtzmd markers required — see tasks 2.2).
- **Pre-commit guard**: runtime evidence required, not just source review — a staged canary line
  containing `db:push` MUST be rejected (exit 1) and the real in-scope diff MUST pass (exit 0);
  see tasks 2.5.
