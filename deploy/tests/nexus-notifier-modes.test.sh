#!/usr/bin/env bash
# nexus-notifier-modes.test.sh — CI-friendly unit tests for the
# `listen | drain` mode dispatcher in deploy/nexus-notifier.sh.
#
# Strategy
# --------
# `nexus-notifier.sh` is a script with side-effecting helpers (`mkfifo`,
# `curl --no-buffer`, `say`) that we cannot run on Linux CI. To exercise the
# dispatcher branch logic in isolation we make a temp copy of the script and
# `sed`-replace the bodies of `_run_listen` and `_run_drain` with single
# `echo` statements. The case statement at the bottom (`${1:-listen}`) is
# untouched, so we're testing the **dispatcher**, not the listen/drain
# implementations themselves.
#
# This trades a bit of fragility (sed against function blocks) for the
# ability to run the test on any POSIX shell without macOS, FIFOs, network
# access, or audio devices.
#
# Run: bash deploy/tests/nexus-notifier-modes.test.sh
# Spec: openspec/changes/add-tts-playback-queue/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTIFIER="$SCRIPT_DIR/nexus-notifier.sh"

if [ ! -f "$NOTIFIER" ]; then
  echo "FAIL: $NOTIFIER not found" >&2
  exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# ── Build a stubbed copy of the notifier ──────────────────────────────────
# Replace the body of _run_listen and _run_drain with a single echo that
# emits a sentinel. Everything else (helper functions, dispatcher case) is
# preserved verbatim.

STUB="$TMPDIR/nexus-notifier-stub.sh"
awk '
  BEGIN { in_listen = 0; in_drain = 0 }
  /^_run_listen\(\) \{/ {
    print "_run_listen() {"
    print "  echo STUB_RAN_LISTEN"
    print "  return 0"
    print "}"
    in_listen = 1
    next
  }
  /^_run_drain\(\) \{/ {
    print "_run_drain() {"
    print "  echo STUB_RAN_DRAIN"
    print "  return 0"
    print "}"
    in_drain = 1
    next
  }
  in_listen == 1 {
    if ($0 ~ /^\}/) { in_listen = 0 }
    next
  }
  in_drain == 1 {
    if ($0 ~ /^\}/) { in_drain = 0 }
    next
  }
  { print }
' "$NOTIFIER" > "$STUB"

chmod +x "$STUB"

# ── assert helpers ────────────────────────────────────────────────────────
PASS=0
FAIL=0

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  case "$haystack" in
    *"$needle"*)
      echo "  ok  $name"
      PASS=$((PASS + 1))
      ;;
    *)
      echo "  FAIL $name"
      echo "       expected to contain: $needle"
      echo "       got: $haystack"
      FAIL=$((FAIL + 1))
      ;;
  esac
}

assert_nonzero_exit() {
  local name="$1" actual="$2"
  if [ "$actual" -ne 0 ]; then
    echo "  ok  $name (exit=$actual)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name (expected non-zero, got 0)"
    FAIL=$((FAIL + 1))
  fi
}

# ── Tests ─────────────────────────────────────────────────────────────────

echo "nexus-notifier mode dispatcher"

# 1. No arg -> defaults to listen
out="$(bash "$STUB" 2>/dev/null || true)"
assert_eq "no arg defaults to listen" "STUB_RAN_LISTEN" "$out"

# 2. Explicit listen
out="$(bash "$STUB" listen 2>/dev/null || true)"
assert_eq "listen invokes _run_listen" "STUB_RAN_LISTEN" "$out"

# 3. Explicit drain
out="$(bash "$STUB" drain 2>/dev/null || true)"
assert_eq "drain invokes _run_drain" "STUB_RAN_DRAIN" "$out"

# 4. Unknown arg -> exit non-zero with usage on stderr
set +e
err="$(bash "$STUB" garbage 2>&1 >/dev/null)"
rc=$?
set -e
assert_nonzero_exit "unknown arg exits non-zero" "$rc"
assert_contains "unknown arg prints usage" "usage:" "$err"
assert_contains "usage mentions both modes" "listen|drain" "$err"

# ── Summary ───────────────────────────────────────────────────────────────
echo ""
echo "passed: $PASS"
echo "failed: $FAIL"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
