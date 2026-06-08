#!/usr/bin/env bash
# Nexus — GUI-session iOS deploy agent wrapper (nx-tceo6 iOS Aqua bridge)
#
# ProgramArguments target of the LaunchAgent
# dev.leonardoacosta.nexus.ios-deploy.plist. Runs INSIDE the user's Aqua (GUI)
# security session — the only context where the team signing identity
# (8E12…/DX3Y367L2A) signs an iOS device build without errSecInternalComponent.
#
# A non-Aqua caller (a build over `ssh mac`, managername=Background) detects it
# is headless, `launchctl kickstart`s this agent, then polls the completion
# marker this script writes. Sibling of deploy/lib/macos-deploy-agent.sh.
#
# Contract:
#   * Always writes a completion marker (first token OK / SKIP / FAIL).
#   * Forces inline build+install in THIS Aqua session (NX_IOS_DEPLOY_MODE=inline).
#   * Fail-soft: never exit non-zero in a way that respawn-storms launchd.
#   * Resolves the target device from NX_IOS_DEVICE_UDID (set via
#     `launchctl setenv` by the SSH-side caller) or the lib default.

set -uo pipefail

REPO_DIR="${NX_REPO_DIR:-$HOME/dev/nx}"
LOG="$HOME/Library/Logs/nexus-ios-deploy.log"
MARKER="$HOME/Library/Application Support/Nexus/ios-deploy-status.txt"
UDID_FILE="$HOME/Library/Application Support/Nexus/ios-deploy-device.txt"

mkdir -p "$(dirname "$LOG")" "$(dirname "$MARKER")" 2>/dev/null || true

# The SSH-side caller can't reliably push an env var into a launchd-kickstarted
# process, so it writes the target UDID to a sentinel file we read here. Falls
# back to NX_IOS_DEVICE_UDID (if launchd happened to carry it) then the lib
# default.
if [[ -z "${NX_IOS_DEVICE_UDID:-}" && -s "$UDID_FILE" ]]; then
    NX_IOS_DEVICE_UDID="$(tr -d '[:space:]' <"$UDID_FILE" 2>/dev/null || true)"
fi

log()  { printf '%s nexus-ios-deploy-agent: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1" >>"$LOG" 2>&1; }
mark() { printf '%s\n' "$1" >"$MARKER" 2>/dev/null || true; }

{
    printf '\n===== %s kickstart (managername=%s, uid=%s, device=%s) =====\n' \
        "$(date '+%Y-%m-%dT%H:%M:%S')" "$(launchctl managername 2>/dev/null || echo '?')" \
        "$(id -u)" "${NX_IOS_DEVICE_UDID:-<default>}"
} >>"$LOG" 2>&1

LIB="$REPO_DIR/deploy/lib/ios-device-deploy.sh"
if [[ ! -f "$LIB" ]]; then
    log "FAIL: shared lib not found at $LIB"
    mark "FAIL lib-not-found $LIB"
    exit 0
fi

log "starting inline iOS build+install (NX_IOS_DEPLOY_MODE=inline, device=${NX_IOS_DEVICE_UDID:-<default>})"

# shellcheck source=ios-device-deploy.sh
source "$LIB"

# Pass the device through the env the lib already honors (NX_IOS_DEVICE_UDID).
# Avoid empty-array expansion — bash 3.2 errors on "${arr[@]}" under set -u.
NX_IOS_DEPLOY_MODE=inline NX_IOS_DEVICE_UDID="${NX_IOS_DEVICE_UDID:-}" \
    ios_device_deploy_run >>"$LOG" 2>&1
rc=$?

case "$rc" in
    0) log "OK: signed iOS build installed on device"; mark "OK ios install $(date '+%Y-%m-%dT%H:%M:%S')" ;;
    2) log "SKIP: install skipped"; mark "SKIP $(date '+%Y-%m-%dT%H:%M:%S')" ;;
    *) log "FAIL: iOS deploy failed (rc=$rc)"; mark "FAIL rc=$rc $(date '+%Y-%m-%dT%H:%M:%S')" ;;
esac

exit 0
