#!/usr/bin/env bash
#
# Regression self-test for the Tier B XCUITest harness cleanup path
# (spec fix-tier-b-xcuitest-harness 1.3, bd:nx-cqd7k).
#
# Guards against the bash-3.2 empty-array-under-nounset defect that buried the
# real Tier B failure on 2026-05-25: expanding "${TEST_LOGS[@]}" while the
# array is empty raised `unbound variable` inside the EXIT trap's cleanup(),
# overwriting the genuine failure output and exit code.
#
# This MUST run under /bin/bash (bash 3.2 on the macOS hosts), NOT homebrew
# bash 4+, because the defect is specific to bash 3.2's nounset handling.
#
# Strategy (option a from the spec): the harness now guards its executing body
# with a run-if-main check, so *sourcing* it only loads function + variable
# definitions. We source it under `set -euo pipefail`, call cleanup() with an
# EMPTY TEST_LOGS, and assert no `unbound variable` error escapes and the call
# returns 0. We also assert the nounset-safe expansion pattern is present in the
# harness source as a belt-and-suspenders structural check.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$HERE/../run-tier-b-xcuitests.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$HARNESS" ]] || fail "harness not found at $HARNESS"

# --- Check 1: the nounset-safe alternate-value expansion is present ----------
# `${TEST_LOGS[@]+...}` is the bash-3.2-safe form; the bare `${TEST_LOGS[@]}`
# under `set -u` is the bug. Assert the safe form is wired in.
if ! grep -q '${TEST_LOGS\[@\]+' "$HARNESS"; then
  fail "harness is missing the nounset-safe \${TEST_LOGS[@]+...} expansion"
fi
echo "ok: harness uses the nounset-safe \${TEST_LOGS[@]+...} expansion"

# --- Check 2: sourcing + cleanup() with empty TEST_LOGS must not crash -------
# Run in a child /bin/bash so the run-if-main guard sees BASH_SOURCE != $0 and
# main() does NOT execute (no stub launch, no xcodebuild). Capture stderr to
# assert no `unbound variable` leaks out.
ERR_OUT="$(
  /bin/bash -c '
    set -euo pipefail
    source "'"$HARNESS"'"
    # Prove main() did not run: STUB_PID must still be the empty default.
    [[ -z "${STUB_PID}" ]] || { echo "main() unexpectedly ran (STUB_PID set)" >&2; exit 3; }
    # The crash path: empty array expansion inside the EXIT trap.
    cleanup
    echo "CLEANUP_OK"
  ' 2>&1 1>/dev/null
)" || fail "sourcing + cleanup() exited non-zero: $ERR_OUT"

STD_OUT="$(
  /bin/bash -c '
    set -euo pipefail
    source "'"$HARNESS"'"
    cleanup
    echo "CLEANUP_OK"
  ' 2>/dev/null
)"

case "$ERR_OUT" in
  *"unbound variable"*)
    fail "cleanup() emitted an 'unbound variable' error: $ERR_OUT" ;;
esac

case "$STD_OUT" in
  *CLEANUP_OK*) : ;;
  *) fail "cleanup() did not complete (no CLEANUP_OK sentinel); stdout=$STD_OUT" ;;
esac
echo "ok: sourcing harness + cleanup() with empty TEST_LOGS is nounset-safe (no 'unbound variable')"

# --- Check 3: isolated repro proves the exact expansion is bash-3.2-safe -----
# Belt-and-suspenders: exercise the precise form in a clean subshell so a future
# refactor that drops the +alternate is caught even if the harness is renamed.
REPRO_OUT="$(
  /bin/bash -c '
    set -euo pipefail
    TEST_LOGS=()
    for log in "${TEST_LOGS[@]+"${TEST_LOGS[@]}"}"; do :; done
    echo REPRO_OK
  ' 2>&1
)" || fail "isolated bash-3.2 repro of the safe expansion failed: $REPRO_OUT"
[[ "$REPRO_OUT" == "REPRO_OK" ]] || fail "isolated repro unexpected output: $REPRO_OUT"
echo "ok: isolated bash-3.2 repro of \${TEST_LOGS[@]+...} is safe"

echo "PASS: tier-b-cleanup self-test (bash-3.2 nounset-safe cleanup)"
