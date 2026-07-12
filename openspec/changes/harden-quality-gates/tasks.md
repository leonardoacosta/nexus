<!-- beads:epic:nx-yn00u -->
<!-- beads:feature:nx-13ekv -->

# Tasks — harden-quality-gates

Full step-by-step detail, exact diffs, and STOP conditions live in
`plans/023-regreen-sql-safety-lint-ci.md` (tasks 1.x) and
`plans/024-fix-dbpush-operator-instruction.md` (tasks 2.x). Each task below cites its source step.

## API Batch

- [x] 1.1 Reproduce the red baseline: `bash scripts/lint-sql-safety.sh` shows exactly one [beads:nx-k6c27]
      violation at `apps/web/src/lib/elevenlabs-client.ts:155`. (plans/023 Step 1)
- [x] 1.2 Add `// SAFE: HTTP route in an error message, not SQL` trailing comment at [beads:nx-zpni6]
      `apps/web/src/lib/elevenlabs-client.ts:155`. (plans/023 Step 2)
- [x] 1.3 Harden `scripts/lint-sql-safety.sh` Pattern 1 regex (line 49) to [beads:nx-yp647]
      `(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\s+(\$\{|[^/[:space:]].*\$\{)` and
      extend the exclude-comment block with the rationale. (plans/023 Step 3)
- [x] 1.4 Prove detection power is preserved via the ephemeral `/tmp` fixture (7 true-positive SQL [beads:nx-zqpr7]
      shapes retained, 2 HTTP-verb shapes excluded) and the in-repo SAFE-annotation count (8).
      (plans/023 Step 4)
- [x] 1.5 Run `pnpm typecheck`, `pnpm lint`, `bun test apps/web/src/lib` — no failure referencing [beads:nx-8x02z]
      a changed file. (plans/023 Step 5)
- [x] 2.1 Rewrite `SchemaIncompleteError`'s remediation sentence in [beads:nx-b29kp]
      `apps/agent/src/db/database.ts:53-54` to instruct `pnpm --filter @nexus/db db:migrate`
      (migration-based only) instead of the banned `db:push`/`drizzle-kit push`.
      (plans/024 Step 1)
- [x] 2.2 Update `database.test.ts`'s message assertion and add the PG-free [beads:nx-oc3yr]
      "SchemaIncompleteError message" pin test (asserts `db:migrate` present, `db:push` and
      `drizzle-kit push` both absent, with `// banned (nx-vtzmd)` markers so the Step 2.5 guard
      doesn't self-reject the test). (plans/024 Step 2)
- [x] 2.3 Fix the three sibling prose sites: `docker-compose.test.yml:11`, [beads:nx-8olet]
      `apps/agent/src/routes/sessions.test.ts:12`, `packages/core/src/types/health.ts:75-76` —
      comment/doc text only, no behavior change. (plans/024 Steps 3-5)
- [x] 2.4 Create `scripts/hooks/pre-commit-block-db-push.sh` (copy from [beads:nx-yp1fu]
      `~/.claude/skills/t3-code-patterns/templates/pre-commit-block-db-push.sh` if present, else
      the inlined template in plans/024 Step 6) and `chmod +x` it. (plans/024 Step 6)
- [x] 2.5 Wire the guard into `.beads/hooks/pre-commit` AFTER the beads `# --- END BEADS [beads:nx-yltsr]
      INTEGRATION ... ---` marker (never inside the managed block), then prove it bites: a staged
      canary line containing `db:push` is rejected (exit 1 + ERROR); the real in-scope diff passes
      (exit 0). (plans/024 Step 7)
- [x] 2.6 Full gates: `pnpm typecheck`, `pnpm lint`, `bun test apps/agent/src/db/database.test.ts`, [beads:nx-scyzd]
      and confirm `pnpm lint:sql-safety` output is identical to the pre-change baseline (task 2.1's
      edits must not add/remove sql-safety findings). (plans/024 Step 8)

## E2E Batch

- [ ] 3.1 Commit task 1.x's changes (targeted `git add`, conventional commit via `git commit -F`), [beads:nx-0qo6a]
      push, then watch the CI run on main: `gh run list` + `gh run watch`. Expected outcome per
      plans/023 Step 7 — either full green, `lint:sql-safety` green with a later unrelated
      failure, or the run dying earlier at the known `Apply DB schema` migration-replay failure
      (report, do not fix — out of scope). A run failing AT `lint:sql-safety` is a STOP condition.
      (plans/023 Steps 6-7)
- [ ] 3.2 Commit task 2.x's changes (separate targeted `git add`, conventional commit). Do not [beads:nx-bso3s]
      push unless this task explicitly instructs it — plan 024's own git-workflow section left
      push undecided; confirm with the `/apply` operator before pushing task-2 work if task-1 has
      not already landed on main. (plans/024 Git workflow)
