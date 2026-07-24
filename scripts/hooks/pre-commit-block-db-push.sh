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
negation='([Nn]ever|NEVER|[Ff]orbid|[Bb]anned|[Bb]lock|NOT used|not used|instead of|do not|don.t|reject)'

# Exclude this guard's own file from the scan: its source necessarily repeats
# `db:push` many times to explain and match against the very thing it forbids,
# and no negation-word heuristic can cleanly cover every one of its own lines
# (e.g. the bare `pattern=` regex definition, or a "Why:"/"Rationale:" line that
# doesn't happen to contain one of the negation trigger words). This caused a
# real self-trigger on first install (2026-07-06) — the guard blocked committing
# itself. A hook re-stating its own prohibition is not a re-introduction.
#
# Also exclude `.beads/*.jsonl` (bd export output): these are structured data
# dumps of historical bead titles/descriptions, not human-authored scripts/docs
# — a bd export that reshuffles or gains a field (e.g. inlining `dependencies[]`)
# re-surfaces old closed-task prose as new `+` diff lines verbatim, and no
# negation-word heuristic can retroactively annotate someone else's already-
# closed task text. Recurred twice in nx (2026-07-16, 2026-07-17; nx-9qsmb.3) —
# the underlying data never proposed running db:push, the diff just reshuffled.
violations=$(git diff --cached --unified=0 --diff-filter=AM \
  -- . ':!*pre-commit-block-db-push.sh' ':!.beads/*.jsonl' \
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
