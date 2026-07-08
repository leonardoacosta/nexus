#!/usr/bin/env bash
# Nexus — shared iOS device deploy library (nx-tceo6 follow-up: iOS Aqua bridge)
#
# Provides ios_device_deploy_run for both interactive use and automated use.
# It is the iOS sibling of deploy/lib/macos-swift-deploy.sh and mirrors its
# session-context routing: a signed iOS DEVICE build+install only works inside
# the user's Aqua (GUI) security session, so a non-Aqua (SSH/headless) caller
# re-routes through a GUI-scoped LaunchAgent and polls a completion marker.
#
# Public function:
#   ios_device_deploy_run [--device <UDID>]
#     xcodegen generate; builds nexus-ios (Debug, SIGNED, generic/platform=iOS);
#     locates the .app; `xcrun devicectl device install app` to the device;
#     best-effort `device process launch`. Returns 0 on success, non-zero on
#     failure. Fail-soft: warns and returns non-zero rather than exiting the
#     caller (this file is sourced; it MUST NOT `set -e` or `exit` on failure).
#
# ── Signing-context routing (nx-tceo6) ──────────────────────────────
# codesign with the team identity (8E12…/DX3Y367L2A) fails with
# errSecInternalComponent when the build runs in a NON-Aqua security session
# (a background SSH session, managername=Background). It is NOT a keychain-LOCK
# problem — the login keychain is already unlocked in the permanently-logged-in
# console session. It is a session-CONTEXT problem: the team identity only
# signs inside the GUI (Aqua) session.
#
# Therefore:
#   * When ios_device_deploy_run runs OUTSIDE the Aqua session (detected via
#     `launchctl managername` != "Aqua", or SSH_CONNECTION set), it does NOT
#     build inline. It kickstarts the GUI-scoped LaunchAgent
#     `dev.leonardoacosta.nexus.ios-deploy` (which re-enters this lib in the
#     Aqua session with NX_IOS_DEPLOY_MODE=inline) and polls its marker.
#   * When run INSIDE the Aqua session (the kickstarted LaunchAgent, or an
#     interactive run on the console), it builds+installs inline.
#
# uid-501 / no-sudo note: over `ssh mac` you are uid 501, the SAME uid as the
# console/Aqua user, so you can `launchctl bootstrap`/`kickstart gui/501/<label>`
# WITHOUT sudo. There is NO passwordless sudo, so `launchctl asuser` is NOT an
# option — the gui/501 kickstart IS the bridge.
#
# Modes (NX_IOS_DEPLOY_MODE env, default "auto"):
#   auto    — route by session context (kickstart when non-Aqua, inline when Aqua).
#   inline  — force inline build+install in the current session (no kickstart).

# Target device default (iPhone 16 Pro Max). Override with --device <UDID> or
# NX_IOS_DEVICE_UDID env.
NX_IOS_DEFAULT_UDID="1AE26465-387A-5B3F-9012-4CF29A9B3AFB"
NX_IOS_BUNDLE_ID="dev.leonardoacosta.nexus.ios"

# App Store Connect API key for headless -allowProvisioningUpdates (2026-07-08).
# Without this, xcodebuild can only REUSE an already-cached cert/profile for a
# bundle ID — a BRAND NEW bundle ID (e.g. a new extension target's App ID) has
# no cached profile and needs to talk live to the Developer Portal to create
# one, which requires either a GUI-signed-in Xcode account (not available to
# the LaunchAgent's build context) or an ASC API key (this). Fixes the
# "No Accounts" / "No profiles for '<bundle-id>' were found" class of failure
# for any future new target, not just the one that surfaced it (nexus-widgets).
# Override via env if the key is ever rotated; the .p8 itself is NEVER
# committed to git — it lives only at NX_IOS_ASC_KEY_PATH on the Mac.
# NOTE: BRQ7ZBN78B is the confirmed nx-team key (verified against the
# Integrations page 2026-07-08) — a same-issuer sibling key (ZA5D8N707G8T,
# generated same day but for a different purpose/account) was tried first and
# 401'd against Apple's listTeams.action; do not swap back without re-verifying
# on the Integrations page.
NX_IOS_ASC_KEY_ID="${NX_IOS_ASC_KEY_ID:-BRQ7ZBN78B}"
NX_IOS_ASC_ISSUER_ID="${NX_IOS_ASC_ISSUER_ID:-31dc9929-98e0-4093-9c76-5bc3359809b5}"
NX_IOS_ASC_KEY_PATH="${NX_IOS_ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${NX_IOS_ASC_KEY_ID}.p8}"

# LaunchAgent label + paths (keep in sync with the plist under
# deploy/launchagents/dev.leonardoacosta.nexus.ios-deploy.plist):
NX_IOS_DEPLOY_LAUNCHAGENT_LABEL="dev.leonardoacosta.nexus.ios-deploy"
NX_IOS_DEPLOY_LOG="$HOME/Library/Logs/nexus-ios-deploy.log"
NX_IOS_DEPLOY_MARKER="$HOME/Library/Application Support/Nexus/ios-deploy-status.txt"

# ── Resolve repo root relative to this lib file ─────────────────────
_IOS_DEVICE_DEPLOY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DEVICE_DEPLOY_REPO_ROOT="$(cd "$_IOS_DEVICE_DEPLOY_LIB_DIR/../.." && pwd)"

# ── Color-coded output ──────────────────────────────────────────────
_ios_device_deploy_info() { printf '\033[1;32mios-deploy: %s\033[0m\n' "$1"; }
_ios_device_deploy_warn() { printf '\033[1;33mios-deploy: %s\033[0m\n' "$1" >&2; }
_ios_device_deploy_err()  { printf '\033[1;31mios-deploy: %s\033[0m\n' "$1" >&2; }

# Desktop banner (best-effort, no-ops headless).
_ios_device_deploy_banner() {
    local title="$1" msg="$2"
    osascript -e "display notification \"${msg//\"/\\\"}\" with title \"${title//\"/\\\"}\"" \
        >/dev/null 2>&1 || true
}

# True when running inside the user's GUI (Aqua) security session.
_ios_device_deploy_in_aqua() {
    [[ "$(launchctl managername 2>/dev/null || true)" == "Aqua" ]]
}

# Parse --device <UDID> out of the args; fall back to env then default.
_ios_device_deploy_resolve_udid() {
    local udid="${NX_IOS_DEVICE_UDID:-}"
    local prev=""
    for a in "$@"; do
        if [[ "$prev" == "--device" ]]; then udid="$a"; fi
        prev="$a"
    done
    printf '%s' "${udid:-$NX_IOS_DEFAULT_UDID}"
}

# ── Public entry point — session-context router (nx-tceo6) ──────────
# Returns 0 on success (built + installed on device), non-zero on failure.
ios_device_deploy_run() {
    if [[ "$(uname -s)" != "Darwin" ]]; then
        _ios_device_deploy_warn "not macOS — refusing to run iOS device deploy"
        return 1
    fi

    local mode="${NX_IOS_DEPLOY_MODE:-auto}"

    if [[ "$mode" == "auto" ]]; then
        if _ios_device_deploy_in_aqua; then
            _ios_device_deploy_info "Aqua session detected — building+installing inline (signed)"
            NX_IOS_DEPLOY_MODE=inline _ios_device_deploy_build_inline "$@"
            return $?
        fi
        _ios_device_deploy_via_launchagent "$@"
        return $?
    fi

    _ios_device_deploy_build_inline "$@"
    return $?
}

# ── Re-route to the GUI LaunchAgent and poll its marker (nx-tceo6) ──
_ios_device_deploy_via_launchagent() {
    local uid label udid
    uid="$(id -u)"
    label="$NX_IOS_DEPLOY_LAUNCHAGENT_LABEL"
    udid="$(_ios_device_deploy_resolve_udid "$@")"

    _ios_device_deploy_info "non-Aqua session (managername=$(launchctl managername 2>/dev/null || echo '?')) — re-routing signed iOS build via GUI LaunchAgent $label (device $udid)"

    local plist="$HOME/Library/LaunchAgents/$label.plist"
    if [[ ! -f "$plist" ]]; then
        _ios_device_deploy_warn "LaunchAgent plist missing at $plist — run deploy/ios-deploy.sh --install once, or deploy/install.sh"
        return 1
    fi
    launchctl bootstrap "gui/$uid" "$plist" >/dev/null 2>&1 || true

    # Reset the marker so we can detect THIS run's completion.
    mkdir -p "$(dirname "$NX_IOS_DEPLOY_MARKER")" 2>/dev/null || true
    : > "$NX_IOS_DEPLOY_MARKER" 2>/dev/null || true
    local start_epoch; start_epoch="$(date +%s)"

    # Pass the target UDID to the kickstarted agent. A launchd-kickstarted job
    # does not inherit our process env, and `launchctl setenv` is unreliable for
    # this, so we write the UDID to a sentinel file the agent reads. (Also set
    # the launchd env as a best-effort secondary path.)
    printf '%s\n' "$udid" > "$(dirname "$NX_IOS_DEPLOY_MARKER")/ios-deploy-device.txt" 2>/dev/null || true
    launchctl setenv NX_IOS_DEVICE_UDID "$udid" >/dev/null 2>&1 || true

    if ! launchctl kickstart -k "gui/$uid/$label" >/dev/null 2>&1; then
        _ios_device_deploy_err "launchctl kickstart gui/$uid/$label failed — bootstrap it: launchctl bootstrap gui/$uid \"$plist\""
        return 1
    fi
    _ios_device_deploy_info "kickstarted $label in gui/$uid — polling completion marker (timeout 600s)"

    # iOS device builds can be slow (first build, code signing, devicectl
    # install over coredevice). Wait up to 10 minutes.
    local waited=0 line="" timeout=600
    while [[ $waited -lt $timeout ]]; do
        if [[ -s "$NX_IOS_DEPLOY_MARKER" ]]; then
            local mtime; mtime="$(stat -f %m "$NX_IOS_DEPLOY_MARKER" 2>/dev/null || echo 0)"
            if [[ "$mtime" -ge "$start_epoch" ]]; then
                line="$(tail -1 "$NX_IOS_DEPLOY_MARKER" 2>/dev/null || true)"
                break
            fi
        fi
        sleep 3
        waited=$((waited + 3))
    done

    if [[ -z "$line" ]]; then
        _ios_device_deploy_err "GUI iOS deploy agent did not report completion within ${timeout}s — check $NX_IOS_DEPLOY_LOG"
        return 1
    fi

    _ios_device_deploy_info "GUI iOS deploy agent result: $line"
    case "$line" in
        OK*)   return 0 ;;
        SKIP*) _ios_device_deploy_warn "GUI iOS deploy agent SKIPPED: $line"; return 0 ;;
        *)     _ios_device_deploy_err "GUI iOS deploy agent FAILED: $line (log: $NX_IOS_DEPLOY_LOG)"; return 1 ;;
    esac
}

# ── Inline build/install (runs in the current/ Aqua session) ────────
_ios_device_deploy_build_inline() {
    local repo_root="$IOS_DEVICE_DEPLOY_REPO_ROOT"
    local swift_dir="$repo_root/apps/swift"
    local udid; udid="$(_ios_device_deploy_resolve_udid "$@")"

    if [[ ! -d "$swift_dir" ]]; then
        _ios_device_deploy_warn "apps/swift not found at $swift_dir"
        return 1
    fi
    if ! command -v xcodegen >/dev/null 2>&1; then
        _ios_device_deploy_warn "xcodegen not found on PATH (brew install xcodegen)"
        return 1
    fi
    if ! command -v xcodebuild >/dev/null 2>&1; then
        _ios_device_deploy_warn "xcodebuild not found — Xcode CLT required"
        return 1
    fi

    _ios_device_deploy_info "regenerating Xcode project (xcodegen)"
    local xcodegen_out
    if ! xcodegen_out="$(cd "$swift_dir" && xcodegen generate 2>&1)"; then
        _ios_device_deploy_err "xcodegen failed:"; printf '%s\n' "$xcodegen_out" >&2
        return 1
    fi
    if echo "$xcodegen_out" | grep -qE "Spec validation|invalid dependency"; then
        _ios_device_deploy_err "xcodegen reported spec validation errors:"; printf '%s\n' "$xcodegen_out" >&2
        return 1
    fi

    _ios_device_deploy_info "building nexus-ios (Debug, signed, generic/platform=iOS)"
    local build_dir
    build_dir="$(mktemp -d -t nx-ios-deploy.XXXXXX)" || {
        _ios_device_deploy_warn "mktemp failed"; return 1
    }

    # ASC API key args — only added when the key file is actually present, so
    # a moved/rotated/missing key degrades to the prior cached-profile-only
    # behavior instead of hard-failing xcodebuild on a bad flag.
    local -a asc_auth_args=()
    if [[ -f "$NX_IOS_ASC_KEY_PATH" ]]; then
        asc_auth_args=(
            -authenticationKeyPath "$NX_IOS_ASC_KEY_PATH"
            -authenticationKeyID "$NX_IOS_ASC_KEY_ID"
            -authenticationKeyIssuerID "$NX_IOS_ASC_ISSUER_ID"
        )
        _ios_device_deploy_info "using ASC API key $NX_IOS_ASC_KEY_ID for live provisioning updates"
    else
        _ios_device_deploy_warn "no ASC API key at $NX_IOS_ASC_KEY_PATH — provisioning updates will only reuse already-cached profiles"
    fi

    # SIGNED build. Use PIPESTATUS to recover the real exit code through the
    # `| tail` pipe so a silent compile/sign failure does not look like success.
    (cd "$swift_dir" && xcodebuild \
            -project nexus.xcodeproj \
            -scheme nexus-ios \
            -configuration Debug \
            -destination 'generic/platform=iOS' \
            -derivedDataPath "$build_dir" \
            -allowProvisioningUpdates \
            "${asc_auth_args[@]}" \
            DEVELOPMENT_TEAM=DX3Y367L2A \
            CODE_SIGN_STYLE=Automatic \
            build 2>&1 | tail -30)
    local xcodebuild_rc="${PIPESTATUS[0]:-1}"
    if [[ "$xcodebuild_rc" -ne 0 ]]; then
        _ios_device_deploy_err "SIGNED nexus-ios build failed (rc=$xcodebuild_rc) — not installing"
        _ios_device_deploy_banner "Nexus iOS deploy: build failed" "nexus-ios signed build failed — see ~/Library/Logs/nexus-ios-deploy.log"
        rm -rf "$build_dir"
        return 1
    fi
    _ios_device_deploy_info "built SIGNED nexus-ios bundle (team DX3Y367L2A)"

    # Locate the .app. PRODUCT_NAME=nexus, so the product is nexus.app;
    # -iname is case-insensitive to survive PRODUCT_NAME case drift.
    local app_path
    app_path="$(find "$build_dir" -path '*/Build/Products/Debug-iphoneos/*.app' -type d -iname 'nexus.app' -print -quit 2>/dev/null || true)"
    if [[ -z "$app_path" || ! -d "$app_path" ]]; then
        _ios_device_deploy_warn "build succeeded but nexus.app not found under Build/Products/Debug-iphoneos in $build_dir"
        rm -rf "$build_dir"
        return 1
    fi
    _ios_device_deploy_info "located built bundle at $app_path"

    # Verify team-signing before touching the device.
    local built_team
    built_team="$(codesign -dv --verbose=2 "$app_path" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
    if [[ "$built_team" != "DX3Y367L2A" ]]; then
        _ios_device_deploy_err "built bundle is NOT team-signed (TeamIdentifier=${built_team:-not set}) — refusing device install"
        rm -rf "$build_dir"
        return 1
    fi
    _ios_device_deploy_info "verified team-signed (TeamIdentifier=DX3Y367L2A)"

    # ── Install to the device ───────────────────────────────────────
    _ios_device_deploy_info "installing to device $udid via devicectl"
    local install_out
    install_out="$(xcrun devicectl device install app --device "$udid" "$app_path" 2>&1)"
    local install_rc=$?
    printf '%s\n' "$install_out"
    if [[ "$install_rc" -ne 0 ]]; then
        _ios_device_deploy_err "devicectl install failed (rc=$install_rc) — is the device available(paired)? \`xcrun devicectl list devices\`"
        rm -rf "$build_dir"
        return 1
    fi
    _ios_device_deploy_info "devicectl install succeeded"

    # ── Launch (best-effort — install is the contractually-required step) ─
    _ios_device_deploy_info "launching $NX_IOS_BUNDLE_ID on device $udid"
    local launch_out
    launch_out="$(xcrun devicectl device process launch --device "$udid" "$NX_IOS_BUNDLE_ID" 2>&1)"
    local launch_rc=$?
    printf '%s\n' "$launch_out"
    if [[ "$launch_rc" -ne 0 ]]; then
        _ios_device_deploy_warn "devicectl launch returned rc=$launch_rc (install OK; launch is best-effort)"
    fi

    rm -rf "$build_dir"
    return 0
}
