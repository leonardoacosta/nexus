#!/usr/bin/env bash
set -euo pipefail

# Drift guard for remove-macos-deploy-agent-daemon.
# macOS runs NO nexus-agent daemon under the spine model (Swift app +
# Tailnet only). Fail if deploy/ ever reintroduces a launchd plist or a
# `com.nexus.agent` launchctl invocation. Run from repo root or anywhere.

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rc=0

if find "$DEPLOY_DIR" -name '*.plist' -print -quit | grep -q .; then
    echo "check-no-mac-daemon: FAIL — deploy/ contains a *.plist (macOS daemon decommissioned)" >&2
    rc=1
fi

SELF="$(basename "${BASH_SOURCE[0]}")"
if grep -rIlE 'com\.nexus\.agent.*launchctl|launchctl.*com\.nexus\.agent' \
        --exclude="$SELF" "$DEPLOY_DIR" 2>/dev/null; then
    echo "check-no-mac-daemon: FAIL — deploy/ invokes launchctl for com.nexus.agent" >&2
    rc=1
fi

[[ $rc -eq 0 ]] && echo "check-no-mac-daemon: OK — no macOS daemon artifacts in deploy/"
exit $rc
