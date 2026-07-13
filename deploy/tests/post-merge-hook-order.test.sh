#!/usr/bin/env bash
#
# E2E harness for the post-merge dispatcher's ordering + non-blocking contract
# (bd:nx-0fiz — "verify post-merge runs all hooks in order on a multi-domain
# merge"). Drives the REAL production dispatcher
# (deploy/hooks/post-merge-dispatcher) against an ISOLATED fixture hooks dir via
# the POST_MERGE_HOOKS_DIR override seam, so no real hook (bun install,
# systemctl, ssh, migrations) ever fires.
#
# Fixture models a multi-domain merge (DB + agent + UI + Swift all touched):
# six numbered stub hooks, each appending its own basename to a shared ordered
# log. The middle hook (03-migrate) deliberately exit 1s, standing in for a
# migration step that failed because the merge touched the DB. The dispatcher's
# contract is that this failure is WARNED and SKIPPED, never blocking the later
# domains (04-swift-deploy / 05-nexus-emit / 06-ios-deploy).
#
# Contract proven:
#   1. Hooks run in ascending numeric/glob order (01..06).
#   2. A mid-chain failing hook does NOT block subsequent hooks.
#   3. The dispatcher exits 0 overall and warns on stderr for the failed hook.
#   4. Non-executable entries in the dir are skipped (the [ -x ] gate).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
DISPATCHER="$REPO_ROOT/deploy/hooks/post-merge-dispatcher"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -x "$DISPATCHER" ]] || fail "dispatcher not executable at $DISPATCHER"

WORK="$(mktemp -d -t nx-post-merge-order-test.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

FIXTURE="$WORK/hooks.d"
mkdir -p "$FIXTURE"
LOG="$WORK/run-order.log"
: >"$LOG"

# Build stub hooks. Each appends its basename to the shared log. 03-migrate
# additionally exit 1s to simulate a DB-domain migration failure mid-chain.
make_stub() {
  local name="$1" exit_code="$2"
  cat >"$FIXTURE/$name" <<EOF
#!/bin/sh
echo "$name" >> "$LOG"
exit $exit_code
EOF
  chmod +x "$FIXTURE/$name"
}

make_stub 01-beads        0
make_stub 02-deploy       0
make_stub 03-migrate      1   # deliberate mid-chain failure (DB migration)
make_stub 04-swift-deploy 0
make_stub 05-nexus-emit   0
make_stub 06-ios-deploy   0

# A non-executable file in the dir — must be skipped by the [ -x ] gate and
# never appear in the log.
cat >"$FIXTURE/README-not-a-hook" <<EOF
#!/bin/sh
echo "README-not-a-hook" >> "$LOG"
EOF
chmod -x "$FIXTURE/README-not-a-hook"

# Run the REAL dispatcher against the fixture. cd into the repo so the
# dispatcher's own `git rev-parse` succeeds cleanly (its result is unused once
# the override is set). Capture stdout, stderr, and exit code independently.
STDERR_FILE="$WORK/stderr.txt"
set +e
(
  cd "$REPO_ROOT" || exit 127
  POST_MERGE_HOOKS_DIR="$FIXTURE" "$DISPATCHER" "arg-one" "arg-two"
) 2>"$STDERR_FILE"
EXIT_CODE=$?
set -e

STDERR_CONTENT="$(cat "$STDERR_FILE")"

echo "--- run-order.log ---"
cat "$LOG"
echo "--- stderr ---"
printf '%s\n' "$STDERR_CONTENT"
echo "--- exit code: $EXIT_CODE ---"

# ── Assertion 1: exact ascending order, all six ran ──────────────────
EXPECTED="01-beads
02-deploy
03-migrate
04-swift-deploy
05-nexus-emit
06-ios-deploy"
ACTUAL="$(cat "$LOG")"
[[ "$ACTUAL" == "$EXPECTED" ]] || fail "run order mismatch.
expected:
$EXPECTED
actual:
$ACTUAL"
echo "ok: all six hooks ran in ascending numeric order (01..06)"

# ── Assertion 2: non-blocking — hooks AFTER the failing 03 still ran ──
for after in 04-swift-deploy 05-nexus-emit 06-ios-deploy; do
  grep -qx "$after" "$LOG" || fail "non-blocking violated: '$after' did not run after 03-migrate failed"
done
echo "ok: 04/05/06 ran despite 03-migrate exiting 1 (mid-chain failure did not block)"

# ── Assertion 3: dispatcher warned on stderr + exited 0 overall ──────
[[ "$EXIT_CODE" -eq 0 ]] || fail "expected dispatcher exit 0 on mid-chain failure, got $EXIT_CODE"
case "$STDERR_CONTENT" in
  *"Warning: post-merge hook '03-migrate' failed (continuing)"*) : ;;
  *) fail "expected stderr warning naming '03-migrate'; got: $STDERR_CONTENT" ;;
esac
echo "ok: dispatcher exited 0 and warned on stderr for the failed hook"

# ── Assertion 4: non-executable entry was skipped ───────────────────
grep -qx "README-not-a-hook" "$LOG" && fail "non-executable file was run (the [ -x ] gate failed)"
echo "ok: non-executable entry skipped ([ -x ] gate honored)"

echo "PASS: post-merge dispatcher order + non-blocking + skip-non-exec contract"
