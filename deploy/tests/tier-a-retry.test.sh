#!/usr/bin/env bash
#
# Controlled harness for the Tier A retry-once contract
# (spec fix-nx-yyy62-flaky-agent-test 2.1, bd:nx-5n6wo).
#
# Drives deploy/lib/tier-a-retry.sh's run_tier_a_with_retry() through ALL
# THREE branches WITHOUT a real push or the real test suite. The suite
# command is injected via the documented seam: each case defines its own
# `tier_a_suite_cmd` function (a stub driven by an attempt counter) BEFORE
# calling run_tier_a_with_retry. The flake log is redirected to an isolated
# temp dir so the run never touches the real ~/.local/state/nexus/flake.log.
#
# Branches proven:
#   - flaky-once: stub fails attempt 1, passes attempt 2 -> return 0
#                 (push proceeds) AND a flake-log line was appended carrying
#                 the captured "(fail)" test name.
#   - hard-fail:  stub fails both attempts -> return 1 (push aborts).
#   - clean:      stub passes attempt 1 -> return 0, NO retry, NO flake line.
#
# Each case runs in its OWN child /bin/bash (bash 3.2) under
# `set -euo pipefail` so function/counter state never leaks between cases and
# we exercise the exact nounset regime the hook runs under.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$HERE/../lib/tier-a-retry.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$HELPER" ]] || fail "helper not found at $HELPER"

# Isolated state root so the real flake log is never touched.
WORK="$(mktemp -d -t nx-tier-a-test.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Shared driver template. Each case exports CASE=<flaky|hard|clean> and a
# COUNTER_FILE, defines tier_a_suite_cmd accordingly, then runs the helper.
# It echoes a RESULT line we parse, plus the final flake-log contents.
run_case() {
  local case_name="$1"
  local counter_file="$WORK/$case_name.counter"
  echo 0 >"$counter_file"

  /bin/bash -c '
    set -euo pipefail
    export FLAKE_LOG_DIR="'"$WORK/$1-state"'"
    export FLAKE_LOG="$FLAKE_LOG_DIR/flake.log"
    COUNTER_FILE="'"$counter_file"'"
    CASE="'"$case_name"'"

    # Stub suite: writes a fake bun "(fail)" line into the log so capture_flake
    # has something to parse, then returns pass/fail per the case + attempt #.
    tier_a_suite_cmd() {
      local _log="$1"
      local n
      n="$(cat "$COUNTER_FILE")"
      n=$(( n + 1 ))
      echo "$n" >"$COUNTER_FILE"

      case "$CASE" in
        flaky)
          if [[ "$n" -eq 1 ]]; then
            printf "(fail) HomelabTransport > liveness roundtrip [stub-flake]\n" >"$_log"
            return 1
          fi
          printf "(pass) HomelabTransport > liveness roundtrip\n" >"$_log"
          return 0 ;;
        hard)
          printf "(fail) HomelabTransport > hard regression [stub-hard]\n" >"$_log"
          return 1 ;;
        clean)
          printf "(pass) HomelabTransport > all green\n" >"$_log"
          return 0 ;;
        *) echo "unknown CASE=$CASE" >&2; return 99 ;;
      esac
    }

    # Source the helper AFTER defining tier_a_suite_cmd so its declare -f guard
    # sees our stub and does NOT install the production default. info()/warn()
    # are left undefined so the helper installs its quiet stderr fallbacks.
    source "'"$HELPER"'"

    if run_tier_a_with_retry; then
      echo "RESULT=0"
    else
      echo "RESULT=1"
    fi
    echo "ATTEMPTS=$(cat "$COUNTER_FILE")"
    if [[ -f "$FLAKE_LOG" ]]; then
      echo "FLAKELINES=$(wc -l <"$FLAKE_LOG" | tr -d " ")"
      echo "FLAKECONTENT<<EOF"
      cat "$FLAKE_LOG"
      echo "EOF"
    else
      echo "FLAKELINES=0"
    fi
  ' _ "$case_name" 2>/dev/null
}

# ── Case 1: flaky-once (fail then pass) ──────────────────────────────
OUT="$(run_case flaky)"
RESULT="$(printf '%s\n' "$OUT" | sed -n 's/^RESULT=//p')"
ATTEMPTS="$(printf '%s\n' "$OUT" | sed -n 's/^ATTEMPTS=//p')"
FLAKELINES="$(printf '%s\n' "$OUT" | sed -n 's/^FLAKELINES=//p')"
[[ "$RESULT" == "0" ]]   || fail "flaky-once: expected RESULT=0 (proceed), got '$RESULT'"
[[ "$ATTEMPTS" == "2" ]] || fail "flaky-once: expected 2 attempts (1 fail + 1 retry), got '$ATTEMPTS'"
[[ "$FLAKELINES" == "1" ]] || fail "flaky-once: expected exactly 1 flake-log line, got '$FLAKELINES'"
case "$OUT" in
  *"stub-flake"*) : ;;
  *) fail "flaky-once: flake log did not capture the failing test name ([stub-flake]); output: $OUT" ;;
esac
echo "ok: flaky-once -> RESULT=0 (push proceeds), 2 attempts, 1 flake line capturing the offender"

# ── Case 2: hard-fail (fail both) ────────────────────────────────────
OUT="$(run_case hard)"
RESULT="$(printf '%s\n' "$OUT" | sed -n 's/^RESULT=//p')"
ATTEMPTS="$(printf '%s\n' "$OUT" | sed -n 's/^ATTEMPTS=//p')"
FLAKELINES="$(printf '%s\n' "$OUT" | sed -n 's/^FLAKELINES=//p')"
[[ "$RESULT" == "1" ]]   || fail "hard-fail: expected RESULT=1 (abort), got '$RESULT'"
[[ "$ATTEMPTS" == "2" ]] || fail "hard-fail: expected 2 attempts (both fail), got '$ATTEMPTS'"
# A hard-fail still captures the first-attempt offender (the contract logs
# on first failure regardless of retry outcome); assert that line landed.
[[ "$FLAKELINES" == "1" ]] || fail "hard-fail: expected the first-attempt failure to be captured (1 line), got '$FLAKELINES'"
echo "ok: hard-fail -> RESULT=1 (push aborts) after 2 attempts"

# ── Case 3: clean (pass first try) ───────────────────────────────────
OUT="$(run_case clean)"
RESULT="$(printf '%s\n' "$OUT" | sed -n 's/^RESULT=//p')"
ATTEMPTS="$(printf '%s\n' "$OUT" | sed -n 's/^ATTEMPTS=//p')"
FLAKELINES="$(printf '%s\n' "$OUT" | sed -n 's/^FLAKELINES=//p')"
[[ "$RESULT" == "0" ]]   || fail "clean: expected RESULT=0 (proceed), got '$RESULT'"
[[ "$ATTEMPTS" == "1" ]] || fail "clean: expected exactly 1 attempt (no retry), got '$ATTEMPTS'"
[[ "$FLAKELINES" == "0" ]] || fail "clean: expected NO flake-log line, got '$FLAKELINES'"
echo "ok: clean -> RESULT=0 (push proceeds), 1 attempt, no retry, no flake line"

echo "PASS: tier-a-retry self-test (flaky-once / hard-fail / clean retry contract)"
