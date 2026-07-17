# Retry-with-backoff wrapper for the per-remote SSH deploy call.
#
# Modeled on deploy/lib/tier-a-retry.sh's shape (declare -f fallback guards
# for info/warn, a single retry-driving function). Extracted for
# nexus-self-healing-infra (nx-695re): a single transient SSH/network blip
# used to fail the ENTIRE remote deploy and fire exactly one FAILED
# notification with no retry — this gives each remote up to
# DEPLOY_RETRY_MAX_ATTEMPTS attempts before giving up.
#
# Sourced, not executed — source-guard idiom (rules/TOOLING.md § Shell Script
# Strict Mode) so a bare `set -e`/`set -u` never leaks into the caller's
# shell.
(return 0 2>/dev/null) || set -euo pipefail

if ! declare -f info >/dev/null 2>&1; then
    info() { printf 'deploy-retry: %s\n' "$1" >&2; }
fi
if ! declare -f warn >/dev/null 2>&1; then
    warn() { printf 'deploy-retry: %s\n' "$1" >&2; }
fi

DEPLOY_RETRY_MAX_ATTEMPTS=3
# Backoff (seconds) before attempt 2 and attempt 3 respectively.
DEPLOY_RETRY_BACKOFFS=(10 30)

# Fire a single fire-and-forget notification to the local nexus-agent
# socket. Failures are swallowed — matches the pre-extraction 02-deploy
# behavior (a notification-delivery failure must never fail the deploy).
_deploy_retry_notify() {
    local message="$1"
    echo "$message" | socat - UNIX-CONNECT:/tmp/nexus-agent.sock 2>/dev/null || true
}

# run_deploy_with_retry <target> <remote-command>
#
# Runs `ssh -o ConnectTimeout=5 -o BatchMode=yes "$target" "<remote-command>"`,
# retrying up to DEPLOY_RETRY_MAX_ATTEMPTS times with backoff
# (DEPLOY_RETRY_BACKOFFS) between attempts. Fires EXACTLY ONE notification
# per call:
#   - a single "Deploy succeeded on $target" the moment any attempt succeeds
#     (a transient failure that recovers on retry never fires a failure
#     notification for the earlier failed attempt(s));
#   - a single "Deploy FAILED on $target" only after every attempt is
#     exhausted.
#
# Returns 0 on eventual success, 1 once all attempts are exhausted. Intended
# to run inside the caller's own backgrounded per-remote subshell (see
# deploy/hooks.d/post-merge/02-deploy's fan-out loop) — one remote's retry
# loop/backoff sleeps never block or fail another remote's.
run_deploy_with_retry() {
    local target="$1"
    local remote_cmd="$2"
    local attempt=1

    while (( attempt <= DEPLOY_RETRY_MAX_ATTEMPTS )); do
        if ssh -o ConnectTimeout=5 -o BatchMode=yes "$target" "$remote_cmd" 2>&1; then
            _deploy_retry_notify "{\"event\":\"notification\",\"message\":\"Deploy succeeded on $target\"}"
            return 0
        fi

        if (( attempt < DEPLOY_RETRY_MAX_ATTEMPTS )); then
            local backoff="${DEPLOY_RETRY_BACKOFFS[$((attempt - 1))]}"
            warn "deploy to $target failed (attempt $attempt/$DEPLOY_RETRY_MAX_ATTEMPTS) — retrying in ${backoff}s"
            sleep "$backoff"
        fi
        (( attempt++ ))
    done

    warn "deploy to $target failed after $DEPLOY_RETRY_MAX_ATTEMPTS attempts — giving up"
    _deploy_retry_notify "{\"event\":\"notification\",\"message\":\"Deploy FAILED on $target\"}"
    return 1
}
