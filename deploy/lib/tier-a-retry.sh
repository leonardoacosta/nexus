# shellcheck shell=bash
#
# Tier A retry-once contract (nx-yyy62 flake relief) — sourceable helper.
#
# Extracted from deploy/hooks.d/pre-push/01-deploy so the retry/flake-capture
# orchestration is testable in isolation (deploy/tests/tier-a-retry.test.sh)
# WITHOUT a real push or the real test suite. The hook sources this file and
# calls run_tier_a_with_retry; behaviour is byte-identical to the prior inline
# block.
#
# Contract:
#   - SUCCESS first try            -> return 0 (proceed; no flake).
#   - FAIL first, SUCCESS retry    -> return 0 (proceed); the first-attempt
#                                     failing test name(s) + timestamp are
#                                     appended to the flake log.
#   - FAIL first, FAIL retry       -> return 1 (caller aborts: a genuine
#                                     failure fails BOTH attempts). The retry
#                                     log tail is emitted to stderr.
#
# Injection seam (for tests): define a shell function named `tier_a_suite_cmd`
# BEFORE calling run_tier_a_with_retry. It receives the log path as $1, MUST
# tee combined stdout+stderr to it, and MUST return the suite's exit status.
# If undefined, a default that runs `NEXUS_HEAVY_TESTS=1 pnpm test` from
# $REPO_DIR is used (the production path).
#
# Configuration via env (all optional, sane defaults):
#   REPO_DIR       — repo root for the default suite command (production).
#   FLAKE_LOG_DIR  — dir for the flake log (default $XDG_STATE_HOME or
#                    ~/.local/state, then /nexus).
#   FLAKE_LOG      — flake log path (default $FLAKE_LOG_DIR/flake.log).
#
# Logging seam: the helper calls info()/warn() if defined by the caller; if
# not (e.g. under test), it falls back to plain stderr prints. This keeps the
# hook's coloured output while staying self-contained when sourced standalone.
#
# bash-3.2-safe: no mapfile / no associative arrays / no bare ${arr[@]} under
# set -u.

# ── Logging fallbacks (only define if the caller hasn't) ──────────────
if ! declare -f info >/dev/null 2>&1; then
    info() { printf 'tier-a: %s\n' "$1" >&2; }
fi
if ! declare -f warn >/dev/null 2>&1; then
    warn() { printf 'tier-a: %s\n' "$1" >&2; }
fi

# ── Flake-log location (overridable; defaulted lazily at call time) ────
_tier_a_init_flake_paths() {
    : "${FLAKE_LOG_DIR:=${XDG_STATE_HOME:-$HOME/.local/state}/nexus}"
    : "${FLAKE_LOG:=$FLAKE_LOG_DIR/flake.log}"
}

# Default suite command (production path). Overridden by tests that define
# their own `tier_a_suite_cmd` before sourcing-or-calling.
if ! declare -f tier_a_suite_cmd >/dev/null 2>&1; then
    tier_a_suite_cmd() {
        # Runs the suite, teeing combined stdout+stderr to $1. Returns the
        # suite's exit status.
        local _log="$1"
        ( cd "${REPO_DIR:?REPO_DIR required for default tier_a_suite_cmd}" \
            && NEXUS_HEAVY_TESTS=1 pnpm test ) >"$_log" 2>&1
    }
fi

capture_flake() {
    # $1 = path to the first-attempt log. Extracts bun "(fail)" test lines
    # and appends "<ISO-timestamp>\t<failing test(s)>" to the flake log.
    local _log="$1"
    local _ts _fails
    _tier_a_init_flake_paths
    _ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    # bun prints failing tests as "(fail) <suite> > <name>" lines. Collapse
    # to a single '|'-joined line; fall back to a marker if none parsed.
    _fails="$(grep -E '\(fail\)' "$_log" 2>/dev/null | sed -E 's/^[[:space:]]*//' | paste -sd '|' - 2>/dev/null)"
    if [[ -z "$_fails" ]]; then
        _fails="(no (fail) lines parsed from log: $_log)"
    fi
    mkdir -p "$FLAKE_LOG_DIR"
    printf '%s\t%s\n' "$_ts" "$_fails" >>"$FLAKE_LOG"
}

run_tier_a_with_retry() {
    # Drives the retry-once contract. Returns 0 on (clean | flaky-once),
    # 1 on (hard-fail). Calls capture_flake on first-attempt failure.
    _tier_a_init_flake_paths
    local _log _retry_log
    _log="$(mktemp -t nx-tier-a.XXXXXX)"
    if tier_a_suite_cmd "$_log"; then
        rm -f "$_log"
        return 0
    fi
    # First attempt failed. Capture the offender, then retry ONCE.
    capture_flake "$_log"
    warn "Tier A: suite failed on first attempt — flake captured to $FLAKE_LOG; retrying once..."
    _retry_log="$(mktemp -t nx-tier-a-retry.XXXXXX)"
    if tier_a_suite_cmd "$_retry_log"; then
        info "Tier A: retry passed — flake absorbed (first-attempt offender logged)"
        rm -f "$_log" "$_retry_log"
        return 0
    fi
    # Failed BOTH times -> real regression. Surface the retry tail, return 1.
    tail -40 "$_retry_log" >&2
    rm -f "$_log" "$_retry_log"
    return 1
}
