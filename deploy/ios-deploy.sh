#!/usr/bin/env bash
# Nexus — iOS device deploy entrypoint (nx-tceo6 iOS Aqua bridge)
#
# Thin wrapper over deploy/lib/ios-device-deploy.sh. Works headless over
# `ssh mac`: when run in a non-Aqua session it kickstarts the GUI LaunchAgent
# (where the team identity signs) and polls the completion marker; when run in
# the Aqua session it builds + installs inline.
#
# Usage:
#   deploy/ios-deploy.sh [--device <UDID>]   # build nexus-ios (signed) + install on device
#   deploy/ios-deploy.sh --install           # (re)load the GUI LaunchAgent into gui/501
#   deploy/ios-deploy.sh --list              # list paired devices (devicectl)
#
# Default device: iPhone 16 Pro Max (1AE26465-387A-5B3F-9012-4CF29A9B3AFB).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/lib/ios-device-deploy.sh"
PLIST_SRC="$SCRIPT_DIR/launchagents/dev.leonardoacosta.nexus.ios-deploy.plist"

if [[ ! -f "$LIB" ]]; then
    echo "ios-deploy: shared lib not found at $LIB" >&2
    exit 1
fi
# shellcheck source=lib/ios-device-deploy.sh
source "$LIB"

# Idempotently (re)load the GUI LaunchAgent into gui/501. Mirrors
# install.sh:install_macos_deploy_agent. No sudo needed (uid 501 == console uid).
install_agent() {
    local label="$NX_IOS_DEPLOY_LAUNCHAGENT_LABEL"
    local dst="$HOME/Library/LaunchAgents/$label.plist"
    local uid; uid="$(id -u)"
    if [[ ! -f "$PLIST_SRC" ]]; then
        echo "ios-deploy: plist not found at $PLIST_SRC" >&2
        return 1
    fi
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" \
             "$HOME/Library/Application Support/Nexus"
    install -m 644 "$PLIST_SRC" "$dst"
    chmod 755 "$SCRIPT_DIR/lib/ios-deploy-agent.sh" 2>/dev/null || true
    echo "ios-deploy: loading GUI iOS deploy agent ($label) into gui/$uid"
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    if launchctl bootstrap "gui/$uid" "$dst" >/dev/null 2>&1; then
        echo "ios-deploy: agent loaded. SSH-side deploys will kickstart it for signed installs."
    else
        echo "ios-deploy: launchctl bootstrap gui/$uid $dst failed — load manually in the GUI session:" >&2
        echo "  launchctl bootout gui/$uid/$label 2>/dev/null; launchctl bootstrap gui/$uid \"$dst\"" >&2
        return 1
    fi
    echo "  log: ~/Library/Logs/nexus-ios-deploy.log    marker: ~/Library/Application Support/Nexus/ios-deploy-status.txt"
}

case "${1:-}" in
    --install) install_agent ;;
    --list)    xcrun devicectl list devices ;;
    *)         ios_device_deploy_run "$@" ;;
esac
