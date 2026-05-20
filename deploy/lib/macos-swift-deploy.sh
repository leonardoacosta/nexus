#!/usr/bin/env bash
# Nexus — shared macOS Swift deploy library
#
# Provides macos_swift_deploy_run for both interactive use (deploy/install.sh)
# and automated use (deploy/hooks.d/post-merge/04-swift-deploy).
#
# Public function:
#   macos_swift_deploy_run [--force]
#     Builds nexus-mac (Release), installs to /Applications/Nexus.app,
#     restarts the running instance. Returns 0 on success, non-zero on failure.
#     Fail-soft: warns and returns 1 rather than exiting the parent script.
#
# This file is sourced; it MUST NOT call `set -e` (that would propagate into the
# caller) and MUST NOT `exit` on failure paths.

# ── Resolve repo root relative to this lib file ─────────────────────
# Use BASH_SOURCE so the lib works whether invoked directly or via `source`.
_MACOS_SWIFT_DEPLOY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS_SWIFT_DEPLOY_REPO_ROOT="$(cd "$_MACOS_SWIFT_DEPLOY_LIB_DIR/../.." && pwd)"

# ── Color-coded output (matches existing hook style) ────────────────
_macos_swift_deploy_info() {
    printf '\033[1;32mswift-deploy: %s\033[0m\n' "$1"
}
_macos_swift_deploy_warn() {
    printf '\033[1;33mswift-deploy: %s\033[0m\n' "$1" >&2
}
_macos_swift_deploy_err() {
    printf '\033[1;31mswift-deploy: %s\033[0m\n' "$1" >&2
}

# ── Public entry point ──────────────────────────────────────────────
#
# Returns:
#   0 — success (Nexus.app built, installed, and relaunched)
#   1 — failure (any step failed; caller should treat as fail-soft)
macos_swift_deploy_run() {
    local repo_root="$MACOS_SWIFT_DEPLOY_REPO_ROOT"
    local swift_dir="$repo_root/apps/swift"

    if [[ "$(uname -s)" != "Darwin" ]]; then
        _macos_swift_deploy_warn "not macOS — refusing to run Swift deploy"
        return 1
    fi

    if [[ ! -d "$swift_dir" ]]; then
        _macos_swift_deploy_warn "apps/swift not found at $swift_dir"
        return 1
    fi

    if ! command -v xcodegen >/dev/null 2>&1; then
        _macos_swift_deploy_warn "xcodegen not found on PATH. Install: brew install xcodegen"
        return 1
    fi

    if ! command -v xcodebuild >/dev/null 2>&1; then
        _macos_swift_deploy_warn "xcodebuild not found — Xcode CLT required"
        return 1
    fi

    _macos_swift_deploy_info "regenerating Xcode project (xcodegen)"
    # Capture xcodegen output. xcodegen exits 0 even on spec-validation
    # errors — detect the silent-fail by grepping its output explicitly.
    local xcodegen_out
    if ! xcodegen_out="$(cd "$swift_dir" && xcodegen generate 2>&1)"; then
        _macos_swift_deploy_err "xcodegen failed:"
        printf '%s\n' "$xcodegen_out" >&2
        return 1
    fi
    if echo "$xcodegen_out" | grep -qE "Spec validation|invalid dependency|errors"; then
        _macos_swift_deploy_err "xcodegen reported spec validation errors:"
        printf '%s\n' "$xcodegen_out" >&2
        return 1
    fi

    _macos_swift_deploy_info "building Nexus.app (Release scheme: nexus-mac)"
    local build_dir
    build_dir="$(mktemp -d -t nx-swift-deploy.XXXXXX)" || {
        _macos_swift_deploy_warn "mktemp failed"
        return 1
    }

    # Note: `cmd 2>&1 | tail -20` masks the exit code via the pipe.
    # Use PIPESTATUS to recover the real status. Without this, silent
    # Swift compile failures (like nx-jmqyk, 2026-05-18) ship to
    # /Applications as missing-app + warn-only output.
    (cd "$swift_dir" && xcodebuild \
            -project nexus.xcodeproj \
            -scheme nexus-mac \
            -configuration Release \
            -derivedDataPath "$build_dir" \
            CODE_SIGN_IDENTITY="" \
            CODE_SIGNING_REQUIRED=NO \
            CODE_SIGNING_ALLOWED=NO \
            build 2>&1 | tail -20)
    local xcodebuild_rc="${PIPESTATUS[0]:-1}"
    if [[ "$xcodebuild_rc" -ne 0 ]]; then
        _macos_swift_deploy_warn "xcodebuild failed (rc=$xcodebuild_rc) — Nexus.app not updated"
        rm -rf "$build_dir"
        return 1
    fi

    # Note: the nexus-mac target sets PRODUCT_NAME=nexus, so xcodebuild
    # produces `nexus.app` (lowercase). The installed bundle name is
    # `/Applications/Nexus.app` (capitalized). Search for either spelling
    # under Build/Products/Release so we don't pick up Debug artefacts left
    # over from a developer's prior run.
    local app_path
    app_path="$(find "$build_dir" -path '*/Build/Products/Release/*.app' -type d \( -name 'nexus.app' -o -name 'Nexus.app' \) -print -quit 2>/dev/null || true)"
    if [[ -z "$app_path" || ! -d "$app_path" ]]; then
        _macos_swift_deploy_warn "xcodebuild succeeded but {n,N}exus.app not found in $build_dir"
        rm -rf "$build_dir"
        return 1
    fi
    _macos_swift_deploy_info "located built bundle at $app_path"

    # ── Stop running instance ───────────────────────────────────────
    # LSUIElement app — no Dock icon, no SIGHUP equivalent. killall by
    # process name; tolerate "no matching processes".
    _macos_swift_deploy_info "stopping running Nexus instance (if any)"
    killall Nexus 2>/dev/null || true
    # Brief settle so the file is no longer held when we cp -R.
    sleep 1

    # ── Install to /Applications ────────────────────────────────────
    if [[ ! -w /Applications && ! -w /Applications/Nexus.app ]] 2>/dev/null; then
        _macos_swift_deploy_warn "/Applications is not writable. Manual command:"
        _macos_swift_deploy_warn "  sudo rm -rf /Applications/Nexus.app && sudo cp -R \"$app_path\" /Applications/Nexus.app"
        rm -rf "$build_dir"
        return 1
    fi

    _macos_swift_deploy_info "installing Nexus.app to /Applications"
    if ! rm -rf /Applications/Nexus.app; then
        _macos_swift_deploy_warn "failed to remove old /Applications/Nexus.app"
        rm -rf "$build_dir"
        return 1
    fi
    if ! cp -R "$app_path" /Applications/Nexus.app; then
        _macos_swift_deploy_warn "failed to copy Nexus.app to /Applications"
        rm -rf "$build_dir"
        return 1
    fi
    rm -rf "$build_dir"

    # ── Relaunch (background, LSUIElement-friendly) ─────────────────
    _macos_swift_deploy_info "relaunching Nexus.app"
    if ! open -ga "/Applications/Nexus.app"; then
        _macos_swift_deploy_warn "open -ga failed; launch manually: open -ga /Applications/Nexus.app"
        return 1
    fi

    # ── Verify it came up ───────────────────────────────────────────
    sleep 2
    if pgrep -fl Nexus.app >/dev/null 2>&1; then
        _macos_swift_deploy_info "Nexus.app running"
    else
        _macos_swift_deploy_warn "Nexus.app did not appear in process list after launch (non-fatal)"
    fi

    return 0
}
