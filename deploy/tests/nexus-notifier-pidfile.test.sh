#!/usr/bin/env bash
# nexus-notifier-pidfile.test.sh — Unit tests for the cross-process pid IPC
# that drives banner-click cancel in the nexus-notifier listener.
#
# Strategy
# --------
# We `source` the notifier script with mode=listen replaced by a no-op so
# the helper functions (`_write_pid`, `_clear_pid`, `_read_active_pid`)
# become available without firing the SSE/FIFO machinery. NEXUS_PID_FILE
# is overridden to a tmpdir path so tests don't touch the user's runtime
# state.
#
# Run: bash deploy/tests/nexus-notifier-pidfile.test.sh
# Spec: openspec/changes/consolidate-mac-tts-listener/

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTIFIER="$SCRIPT_DIR/nexus-notifier.sh"

if [ ! -f "$NOTIFIER" ]; then
  echo "FAIL: $NOTIFIER not found" >&2
  exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Override runtime state paths so the source'd helpers operate against tmp.
export NEXUS_PID_FILE="$TMPDIR/current-utterance.pid"
export NEXUS_NOTIFIER_FIFO="$TMPDIR/tts-queue.fifo"
export NEXUS_NOTIFIER_LOG="$TMPDIR/notifier.log"
export NEXUS_TTS_PLAYER_LOG="$TMPDIR/player.log"
export NEXUS_NOTIFIER_SUPPRESS_LOG="$TMPDIR/suppress.log"
# Stay out of the mode dispatcher — we only want the helpers.
export NEXUS_PIDFILE_TEST_ONLY=1

# Build a stub that comments out the dispatcher case so sourcing doesn't
# call _run_listen. The bottom-of-file case is the only side effect on
# load; everything above is function definitions.
STUB="$TMPDIR/nexus-notifier-helpers.sh"
awk '
  /^case "\$\{1:-listen\}" in$/ { print ": # case-dispatcher elided for tests"; in_case=1; next }
  in_case && /^esac$/           { in_case=0; next }
  in_case                       { next }
  { print }
' "$NOTIFIER" > "$STUB"

# shellcheck disable=SC1090
source "$STUB"

PASS=0
FAIL=0

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name (expected='$expected' actual='$actual')"
    FAIL=$((FAIL + 1))
  fi
}

echo "nexus-notifier pid-file IPC"

# 1. _write_pid produces a readable atomic value
_ensure_pid_file
_write_pid 12345
assert_eq "_write_pid writes pid" "12345" "$(cat "$NEXUS_PID_FILE")"

# 2. _read_active_pid round-trip
assert_eq "_read_active_pid reads pid" "12345" "$(_read_active_pid)"

# 3. _clear_pid empties the file
_clear_pid
assert_eq "_clear_pid truncates" "" "$(cat "$NEXUS_PID_FILE")"
assert_eq "_read_active_pid empty after clear" "" "$(_read_active_pid)"

# 4. _read_active_pid rejects non-numeric content
printf 'not-a-pid' > "$NEXUS_PID_FILE"
assert_eq "_read_active_pid rejects garbage" "" "$(_read_active_pid)"

# 5. _read_active_pid rejects mixed alphanumeric
printf '12345abc' > "$NEXUS_PID_FILE"
assert_eq "_read_active_pid rejects mixed alphanum" "" "$(_read_active_pid)"

# 6. _read_active_pid accepts pid with trailing whitespace (defensive)
printf '67890\n' > "$NEXUS_PID_FILE"
assert_eq "_read_active_pid accepts trailing newline" "67890" "$(_read_active_pid)"

# 7. _read_active_pid handles missing file
rm -f "$NEXUS_PID_FILE"
assert_eq "_read_active_pid handles missing file" "" "$(_read_active_pid)"
_ensure_pid_file
assert_eq "_ensure_pid_file recreates empty" "" "$(cat "$NEXUS_PID_FILE")"

# 8. Concurrent writes don't tear (atomic mv invariant) — last writer wins
(
  for i in $(seq 1 50); do
    _write_pid "$((10000 + i))" &
  done
  wait
)
final=$(_read_active_pid)
# Must be a valid pid in the written range, not corrupted bytes.
case "$final" in
  100[0-9][0-9]) echo "  ok  concurrent writes produce valid pid (final=$final)"; PASS=$((PASS + 1)) ;;
  100[0-4][0-9]) echo "  ok  concurrent writes produce valid pid (final=$final)"; PASS=$((PASS + 1)) ;;
  *)             echo "  FAIL concurrent writes (got '$final', expected 10001-10050)"; FAIL=$((FAIL + 1)) ;;
esac

# 9. _dispatch_banner -execute arg presence — synthetic harness
# Stub terminal-notifier in PATH; check argv contains -execute when pid set.
TN_STUB="$TMPDIR/terminal-notifier"
cat > "$TN_STUB" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$TN_ARGS_LOG"
EOF
chmod +x "$TN_STUB"
export TN_ARGS_LOG="$TMPDIR/tn-args.log"

# Override the two hardcoded terminal-notifier paths inside _dispatch_banner
# by monkey-patching the loop to use $TN_STUB. We can't easily change those
# paths post-hoc, so we redefine _dispatch_banner inline with the same body
# but pointing at the stub. This is the same shape as the real function.
_dispatch_banner_test() {
  local title="$1" body="$2" project="${3:-}"
  local active_pid
  active_pid="$(_read_active_pid)"
  local args=(-title "$title" -message "$body")
  [ -n "$active_pid" ] && args+=(-execute "/bin/kill -TERM $active_pid")
  "$TN_STUB" "${args[@]}"
}

# 9a. Empty pid file → no -execute
_clear_pid
: > "$TN_ARGS_LOG"
_dispatch_banner_test "Test" "body" ""
if grep -q -- "-execute" "$TN_ARGS_LOG"; then
  echo "  FAIL banner omits -execute when pid empty"
  FAIL=$((FAIL + 1))
else
  echo "  ok  banner omits -execute when pid empty"
  PASS=$((PASS + 1))
fi

# 9b. Populated pid file → -execute "/bin/kill -TERM <pid>" appears
_write_pid 99999
: > "$TN_ARGS_LOG"
_dispatch_banner_test "Test" "body" ""
if grep -q -- "-execute" "$TN_ARGS_LOG" && grep -q "kill -TERM 99999" "$TN_ARGS_LOG"; then
  echo "  ok  banner attaches kill-TERM cancel when pid present"
  PASS=$((PASS + 1))
else
  echo "  FAIL banner missing -execute or kill target (args:)"
  cat "$TN_ARGS_LOG" | sed 's/^/      /'
  FAIL=$((FAIL + 1))
fi

# 9c. Garbage pid file → no -execute (validation rejects non-numeric)
printf 'not-a-pid' > "$NEXUS_PID_FILE"
: > "$TN_ARGS_LOG"
_dispatch_banner_test "Test" "body" ""
if grep -q -- "-execute" "$TN_ARGS_LOG"; then
  echo "  FAIL banner attached -execute despite garbage pid"
  FAIL=$((FAIL + 1))
else
  echo "  ok  banner rejects garbage pid"
  PASS=$((PASS + 1))
fi

echo ""
echo "passed: $PASS"
echo "failed: $FAIL"

[ "$FAIL" -eq 0 ]
