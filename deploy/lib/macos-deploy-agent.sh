#!/usr/bin/env bash
# Nexus — GUI-session deploy agent wrapper (nx-tceo6)
#
# This is the ProgramArguments target of the LaunchAgent
# `dev.leonardoacosta.nexus.deploy.plist`. It runs INSIDE the user's Aqua
# (GUI) security session — the only context where the team signing identity
# (8E12…/DX3Y367L2A) signs without errSecInternalComponent.
#
# A non-Aqua caller (the post-merge/post-commit git hook invoked over SSH by
# the homelab fan-out) detects it is headless, `launchctl kickstart`s this
# agent, then polls the completion marker this script writes.
#
# Contract:
#   * Always writes a completion marker (first token OK / SKIP / FAIL) so the
#     poller in macos-swift-deploy.sh can surface the result.
#   * Forces the signed-only path (NX_DEPLOY_MODE=inline + signed default).
#     NEVER ad-hoc — NX_ALLOW_ADHOC is intentionally NOT set here.
#   * Fail-soft: never `exit 1` in a way that respawn-storms launchd (the
#     plist has no KeepAlive; this runs once per kickstart).
#
# Resolves the repo from a fixed checkout. The homelab fan-out git-pulls
# ~/dev/nx before kickstarting, so the working tree is already current.

set -uo pipefail

REPO_DIR="${NX_REPO_DIR:-$HOME/dev/nx}"
LOG="$HOME/Library/Logs/nexus-deploy.log"
MARKER="$HOME/Library/Application Support/Nexus/deploy-status.txt"

mkdir -p "$(dirname "$LOG")" "$(dirname "$MARKER")" 2>/dev/null || true

log() { printf '%s nexus-deploy-agent: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1" >>"$LOG" 2>&1; }
mark() { printf '%s\n' "$1" >"$MARKER" 2>/dev/null || true; }

{
    printf '\n===== %s kickstart (managername=%s, uid=%s) =====\n' \
        "$(date '+%Y-%m-%dT%H:%M:%S')" "$(launchctl managername 2>/dev/null || echo '?')" "$(id -u)"
} >>"$LOG" 2>&1

LIB="$REPO_DIR/deploy/lib/macos-swift-deploy.sh"
if [[ ! -f "$LIB" ]]; then
    log "FAIL: shared lib not found at $LIB"
    mark "FAIL lib-not-found $LIB"
    exit 0
fi

# Build inline in THIS (Aqua) session, signed-only. --force so the agent always
# rebuilds when kickstarted (the path-change gate already ran in the hook).
log "starting signed-only inline build (NX_DEPLOY_MODE=inline)"

# shellcheck source=macos-swift-deploy.sh
source "$LIB"

# Stream the lib's stdout/stderr into the log too.
NX_DEPLOY_MODE=inline macos_swift_deploy_run --force >>"$LOG" 2>&1
rc=$?

case "$rc" in
    0) log "OK: signed build installed"; mark "OK signed install $(date '+%Y-%m-%dT%H:%M:%S')" ;;
    2) log "SKIP: install skipped (not team-signed / downgrade refused)"; mark "SKIP not-team-signed $(date '+%Y-%m-%dT%H:%M:%S')" ;;
    *) log "FAIL: deploy failed (rc=$rc)"; mark "FAIL rc=$rc $(date '+%Y-%m-%dT%H:%M:%S')" ;;
esac

exit 0
