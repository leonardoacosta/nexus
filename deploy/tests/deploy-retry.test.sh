#!/usr/bin/env bash
#
# Controlled harness for deploy/lib/deploy-retry.sh's run_deploy_with_retry()
# contract (nexus-self-healing-infra, remote-deploy-fanout spec, task 3.3).
#
# Drives run_deploy_with_retry() through both terminal branches WITHOUT a
# real SSH connection, a real remote host, or the real 10s/30s backoff:
#   - `ssh` is shadowed on PATH with a stub driven by a per-case attempt
#     counter file (same technique deploy-staleness would need for its own
#     SSH calls — see deploy-staleness.test.ts).
#   - `sleep` is shadowed on PATH to capture the requested duration instead
#     of actually sleeping, so the documented 10s-then-30s backoff is
#     provable without a 40-second test run.
#   - `socat` is shadowed on PATH to capture stdin (the notify JSON payload)
#     instead of connecting to the real, hardcoded `/tmp/nexus-agent.sock`
#     (deploy-retry.sh's `_deploy_retry_notify` has no override seam for the
#     socket path itself, so faking the binary it shells out to is the only
#     way to observe the notification without touching a real agent socket).
#
# Branches proven:
#   - retry-then-succeed: ssh stub fails attempt 1, succeeds attempt 2 ->
#     run_deploy_with_retry returns 0, exactly one 10s sleep, exactly one
#     success notification.
#   - exhausted-retries: ssh stub fails all 3 attempts ->
#     run_deploy_with_retry returns 1, sleeps of 10s then 30s (in that
#     order), exactly one failure notification.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$HERE/../lib/deploy-retry.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$HELPER" ]] || fail "helper not found at $HELPER"

WORK="$(mktemp -d -t nx-deploy-retry-test.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/bin"

# Fake `ssh` — behavior driven by $SSH_MODE, attempt count tracked via
# $SSH_COUNTER_FILE. Ignores its actual args entirely (target/remote_cmd
# don't matter to this contract test).
cat > "$WORK/bin/ssh" <<'FAKESSH'
#!/usr/bin/env bash
n="$(cat "$SSH_COUNTER_FILE" 2>/dev/null || echo 0)"
n=$((n + 1))
echo "$n" > "$SSH_COUNTER_FILE"
case "$SSH_MODE" in
  fail-then-succeed)
    if [[ "$n" -lt 2 ]]; then exit 1; fi
    exit 0 ;;
  always-fail)
    exit 1 ;;
  *)
    echo "unknown SSH_MODE=$SSH_MODE" >&2
    exit 99 ;;
esac
FAKESSH
chmod +x "$WORK/bin/ssh"

# Fake `sleep` — captures the requested duration instead of actually
# sleeping, so the 10s/30s backoff contract is provable without a real wait.
cat > "$WORK/bin/sleep" <<'FAKESLEEP'
#!/usr/bin/env bash
echo "$1" >> "$SLEEP_LOG"
exit 0
FAKESLEEP
chmod +x "$WORK/bin/sleep"

# Fake `socat` — captures the notify payload instead of connecting to the
# real (hardcoded) /tmp/nexus-agent.sock.
cat > "$WORK/bin/socat" <<'FAKESOCAT'
#!/usr/bin/env bash
cat >> "$NOTIFY_LOG"
exit 0
FAKESOCAT
chmod +x "$WORK/bin/socat"

run_case() {
  local mode="$1"
  local ssh_counter="$WORK/$mode.ssh-count"
  local sleep_log="$WORK/$mode.sleep-log"
  local notify_log="$WORK/$mode.notify-log"
  echo 0 >"$ssh_counter"
  : >"$sleep_log"
  : >"$notify_log"

  PATH="$WORK/bin:$PATH" \
  SSH_MODE="$mode" \
  SSH_COUNTER_FILE="$ssh_counter" \
  SLEEP_LOG="$sleep_log" \
  NOTIFY_LOG="$notify_log" \
  /bin/bash -c '
    set -euo pipefail
    source "'"$HELPER"'"
    if run_deploy_with_retry "test-target" "true"; then
      echo "RESULT=0"
    else
      echo "RESULT=1"
    fi
    echo "ATTEMPTS=$(cat "'"$ssh_counter"'")"
  ' 2>/dev/null

  echo "SLEEPS=$(paste -sd, "$sleep_log" 2>/dev/null)"
  echo "NOTIFYCOUNT=$(grep -c '"event"' "$notify_log" 2>/dev/null || echo 0)"
  echo "NOTIFYCONTENT<<EOF"
  cat "$notify_log"
  echo "EOF"
}

# ─── retry-then-succeed ──────────────────────────────────────────────────────

OUT="$(run_case fail-then-succeed)"
RESULT="$(printf '%s\n' "$OUT" | sed -n 's/^RESULT=//p')"
ATTEMPTS="$(printf '%s\n' "$OUT" | sed -n 's/^ATTEMPTS=//p')"
SLEEPS="$(printf '%s\n' "$OUT" | sed -n 's/^SLEEPS=//p')"
NOTIFYCOUNT="$(printf '%s\n' "$OUT" | sed -n 's/^NOTIFYCOUNT=//p')"

[[ "$RESULT" == "0" ]]      || fail "retry-then-succeed: expected RESULT=0, got '$RESULT'"
[[ "$ATTEMPTS" == "2" ]]    || fail "retry-then-succeed: expected 2 ssh attempts (1 fail + 1 success), got '$ATTEMPTS'"
[[ "$SLEEPS" == "10" ]]     || fail "retry-then-succeed: expected exactly one 10s backoff sleep, got '$SLEEPS'"
[[ "$NOTIFYCOUNT" == "1" ]] || fail "retry-then-succeed: expected exactly 1 notification, got '$NOTIFYCOUNT'"
case "$OUT" in
  *"Deploy succeeded on test-target"*) : ;;
  *) fail "retry-then-succeed: notify payload missing success message; output: $OUT" ;;
esac
echo "ok: retry-then-succeed -> RESULT=0, 2 attempts, 1x10s backoff, exactly 1 success notification"

# ─── exhausted-retries ───────────────────────────────────────────────────────

OUT="$(run_case always-fail)"
RESULT="$(printf '%s\n' "$OUT" | sed -n 's/^RESULT=//p')"
ATTEMPTS="$(printf '%s\n' "$OUT" | sed -n 's/^ATTEMPTS=//p')"
SLEEPS="$(printf '%s\n' "$OUT" | sed -n 's/^SLEEPS=//p')"
NOTIFYCOUNT="$(printf '%s\n' "$OUT" | sed -n 's/^NOTIFYCOUNT=//p')"

[[ "$RESULT" == "1" ]]      || fail "exhausted-retries: expected RESULT=1, got '$RESULT'"
[[ "$ATTEMPTS" == "3" ]]    || fail "exhausted-retries: expected 3 ssh attempts (max), got '$ATTEMPTS'"
[[ "$SLEEPS" == "10,30" ]]  || fail "exhausted-retries: expected backoff sequence 10s then 30s, got '$SLEEPS'"
[[ "$NOTIFYCOUNT" == "1" ]] || fail "exhausted-retries: expected exactly 1 notification (not one per attempt), got '$NOTIFYCOUNT'"
case "$OUT" in
  *"Deploy FAILED on test-target"*) : ;;
  *) fail "exhausted-retries: notify payload missing failure message; output: $OUT" ;;
esac
echo "ok: exhausted-retries -> RESULT=1, 3 attempts, 10s then 30s backoff, exactly 1 failure notification"

echo "PASS: deploy-retry self-test (retry-then-succeed / exhausted-retries contract)"
