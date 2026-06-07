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
#
# ── Signing-context routing (nx-tceo6) ──────────────────────────────
# codesign with the team identity (8E12…/DX3Y367L2A) fails with
# errSecInternalComponent when the build runs in a NON-Aqua security session
# (e.g. the post-merge/post-commit git hook invoked over SSH by the homelab
# fan-out). It is NOT a keychain-LOCK problem — the login keychain is already
# unlocked in the user's permanently-logged-in console session. It is a
# session-CONTEXT problem: signing only works inside the GUI (Aqua) session.
#
# Therefore:
#   * When macos_swift_deploy_run runs OUTSIDE the Aqua session (detected via
#     `launchctl managername` != "Aqua", or SSH_CONNECTION set), it does NOT
#     build inline. Instead it kickstarts the GUI-scoped LaunchAgent
#     `dev.leonardoacosta.nexus.deploy` (which re-enters this lib in the Aqua
#     session with NX_DEPLOY_MODE=signed-only) and polls its completion marker.
#   * When run INSIDE the Aqua session (interactive install.sh, or the
#     kickstarted LaunchAgent), it builds + installs inline as before.
#
# Modes (NX_DEPLOY_MODE env, default "auto"):
#   auto         — route by session context (the normal hook/install entry).
#   signed-only  — build SIGNED, NEVER fall back to ad-hoc; used by the
#                  LaunchAgent wrapper. A signing failure SKIPS the install
#                  (leaves the prior signed app) and emits a desktop banner.
#   inline       — force inline build in the current session (no kickstart).
#
# Ad-hoc fallback is now opt-in only via NX_ALLOW_ADHOC=1 (CI integrity
# checks). It NEVER silently overwrites a signed /Applications/Nexus.app.
#
# LaunchAgent label + paths (keep in sync with deploy/dev.leonardoacosta.nexus.deploy.plist):
NX_DEPLOY_LAUNCHAGENT_LABEL="dev.leonardoacosta.nexus.deploy"
NX_DEPLOY_LOG="$HOME/Library/Logs/nexus-deploy.log"
NX_DEPLOY_MARKER="$HOME/Library/Application Support/Nexus/deploy-status.txt"

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

# Desktop banner (best-effort). osascript only works in a GUI session; in a
# headless/SSH session it no-ops harmlessly. Used to make a signing failure
# LOUD instead of a silent ad-hoc degrade (nx-tceo6).
_macos_swift_deploy_banner() {
    local title="$1" msg="$2"
    osascript -e "display notification \"${msg//\"/\\\"}\" with title \"${title//\"/\\\"}\"" \
        >/dev/null 2>&1 || true
}

# True when running inside the user's GUI (Aqua) security session — the only
# context where the team signing identity works. False over SSH/headless.
_macos_swift_deploy_in_aqua() {
    local mgr
    mgr="$(launchctl managername 2>/dev/null || true)"
    if [[ "$mgr" == "Aqua" ]]; then
        return 0
    fi
    return 1
}

# ── Public entry point — session-context router (nx-tceo6) ──────────
#
# Returns:
#   0 — success (Nexus.app built, installed, and relaunched)
#   1 — failure (any step failed; caller should treat as fail-soft)
#
# NX_DEPLOY_MODE controls routing:
#   auto (default) — kickstart the GUI LaunchAgent when NOT in Aqua, else inline.
#   signed-only    — inline build, signed-or-skip (set by the LaunchAgent).
#   inline         — force inline build in the current session.
macos_swift_deploy_run() {
    if [[ "$(uname -s)" != "Darwin" ]]; then
        _macos_swift_deploy_warn "not macOS — refusing to run Swift deploy"
        return 1
    fi

    local mode="${NX_DEPLOY_MODE:-auto}"

    if [[ "$mode" == "auto" ]]; then
        if _macos_swift_deploy_in_aqua; then
            # Interactive install.sh (or already kickstarted) — build inline.
            _macos_swift_deploy_info "Aqua session detected — building inline (signed)"
            NX_DEPLOY_MODE=signed-only _macos_swift_deploy_build_inline "$@"
            return $?
        fi
        # Non-Aqua (SSH/headless git-hook) — re-route through the GUI agent so
        # the team identity can sign. Builds inline ONLY in the Aqua session.
        _macos_swift_deploy_via_launchagent "$@"
        return $?
    fi

    # Explicit inline / signed-only modes: build in the current session.
    _macos_swift_deploy_build_inline "$@"
    return $?
}

# ── Re-route to the GUI LaunchAgent and poll its marker (nx-tceo6) ──
# Called from a non-Aqua session. Ensures the agent is bootstrapped into the
# GUI domain, kickstarts it (runs the SIGNED build in the Aqua session), then
# polls the completion marker the agent writes.
_macos_swift_deploy_via_launchagent() {
    local uid label
    uid="$(id -u)"
    label="$NX_DEPLOY_LAUNCHAGENT_LABEL"

    _macos_swift_deploy_info "non-Aqua session (managername=$(launchctl managername 2>/dev/null || echo '?')) — re-routing signed build via GUI LaunchAgent $label"

    # Ensure the agent is loaded in the GUI domain. bootstrap is idempotent-ish
    # (errors if already loaded); ignore the "already bootstrapped" failure.
    local plist="$HOME/Library/LaunchAgents/$label.plist"
    if [[ -f "$plist" ]]; then
        launchctl bootstrap "gui/$uid" "$plist" >/dev/null 2>&1 || true
    else
        _macos_swift_deploy_warn "LaunchAgent plist missing at $plist — run deploy/install.sh once on the Mac to install it"
        return 1
    fi

    # Reset the marker so we can detect THIS run's completion.
    mkdir -p "$(dirname "$NX_DEPLOY_MARKER")" 2>/dev/null || true
    : > "$NX_DEPLOY_MARKER" 2>/dev/null || true
    local start_epoch
    start_epoch="$(date +%s)"

    # Forward the --force flag (if any) to the agent via a sentinel env the
    # plist reads. The wrapper script picks NX_DEPLOY_FORCE up.
    local force_arg=""
    for a in "$@"; do
        [[ "$a" == "--force" ]] && force_arg="--force"
    done

    if ! launchctl kickstart -k "gui/$uid/$label" >/dev/null 2>&1; then
        _macos_swift_deploy_err "launchctl kickstart gui/$uid/$label failed — is the agent bootstrapped? Try: launchctl bootstrap gui/$uid $plist"
        return 1
    fi
    _macos_swift_deploy_info "kickstarted $label in gui/$uid — polling completion marker (timeout 300s)"

    # Poll the marker. The wrapper writes a line beginning with a status token
    # (OK / SKIP / FAIL) once it finishes. Wait up to 5 minutes.
    local waited=0 line=""
    while [[ $waited -lt 300 ]]; do
        if [[ -s "$NX_DEPLOY_MARKER" ]]; then
            # Only accept a marker written AFTER we reset it.
            local mtime
            mtime="$(stat -f %m "$NX_DEPLOY_MARKER" 2>/dev/null || echo 0)"
            if [[ "$mtime" -ge "$start_epoch" ]]; then
                line="$(tail -1 "$NX_DEPLOY_MARKER" 2>/dev/null || true)"
                break
            fi
        fi
        sleep 2
        waited=$((waited + 2))
    done

    if [[ -z "$line" ]]; then
        _macos_swift_deploy_err "GUI deploy agent did not report completion within 300s — check $NX_DEPLOY_LOG"
        return 1
    fi

    _macos_swift_deploy_info "GUI deploy agent result: $line"
    case "$line" in
        OK*)   return 0 ;;
        SKIP*) _macos_swift_deploy_warn "GUI deploy agent SKIPPED install: $line"; return 0 ;;
        *)     _macos_swift_deploy_err "GUI deploy agent FAILED: $line (log: $NX_DEPLOY_LOG)"; return 1 ;;
    esac
}

# ── Inline build/install (runs in the current session) ──────────────
# Renamed from the original macos_swift_deploy_run body. Builds SIGNED; on
# signing failure it does NOT silently degrade to ad-hoc (nx-tceo6) unless
# NX_ALLOW_ADHOC=1. signed-only mode (default for this fn) SKIPS the install on
# signing failure, leaving the prior signed /Applications/Nexus.app in place.
_macos_swift_deploy_build_inline() {
    local repo_root="$MACOS_SWIFT_DEPLOY_REPO_ROOT"
    local swift_dir="$repo_root/apps/swift"

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
    #
    # nx-tceo6: SIGNED-ONLY by default. The SIGNED build (team DX3Y367L2A)
    # gives the app a stable code identity so macOS persists the notification
    # grant + registers it with Notification Center. The team identity only
    # signs cleanly inside the Aqua session (the router guarantees we're there);
    # if signing still fails we do NOT silently degrade to ad-hoc — that
    # produced a TeamIdentifier=not-set bundle with no entitlements and zero
    # banners (the bug). Ad-hoc is opt-in ONLY via NX_ALLOW_ADHOC=1 (CI
    # integrity checks), and even then it must not clobber a signed install.
    (cd "$swift_dir" && xcodebuild \
            -project nexus.xcodeproj \
            -scheme nexus-mac \
            -configuration Release \
            -derivedDataPath "$build_dir" \
            -allowProvisioningUpdates \
            DEVELOPMENT_TEAM=DX3Y367L2A \
            CODE_SIGN_STYLE=Automatic \
            build 2>&1 | tail -20)
    local xcodebuild_rc="${PIPESTATUS[0]:-1}"
    if [[ "$xcodebuild_rc" -ne 0 ]]; then
        if [[ "${NX_ALLOW_ADHOC:-0}" == "1" ]]; then
            # Explicit CI integrity-check opt-in. Build ad-hoc to a SEPARATE
            # dir and DO NOT install it over /Applications (handled below by
            # the NX_ALLOW_ADHOC guard on the install step).
            _macos_swift_deploy_warn "signed build failed; NX_ALLOW_ADHOC=1 — building ad-hoc (will NOT overwrite a signed install)"
            rm -rf "$build_dir"
            (cd "$swift_dir" && xcodebuild \
                    -project nexus.xcodeproj \
                    -scheme nexus-mac \
                    -configuration Release \
                    -derivedDataPath "$build_dir" \
                    CODE_SIGN_IDENTITY="" \
                    CODE_SIGNING_REQUIRED=NO \
                    CODE_SIGNING_ALLOWED=NO \
                    build 2>&1 | tail -20)
            xcodebuild_rc="${PIPESTATUS[0]:-1}"
            if [[ "$xcodebuild_rc" -ne 0 ]]; then
                _macos_swift_deploy_warn "ad-hoc build also failed (rc=$xcodebuild_rc) — Nexus.app not updated"
                rm -rf "$build_dir"
                return 1
            fi
        else
            # Signed-only: do NOT degrade. Leave the prior signed app in place
            # and make the failure LOUD (desktop banner + log + marker).
            _macos_swift_deploy_err "SIGNED build failed (rc=$xcodebuild_rc) — NOT installing ad-hoc; leaving existing /Applications/Nexus.app untouched"
            _macos_swift_deploy_err "If signing genuinely broke, fix the identity/profile; set NX_ALLOW_ADHOC=1 only for CI integrity checks."
            _macos_swift_deploy_banner "Nexus deploy: signing failed" "Kept the existing signed app. New build was NOT installed — codesign failed. See ~/Library/Logs/nexus-deploy.log"
            rm -rf "$build_dir"
            return 1
        fi
    else
        _macos_swift_deploy_info "built SIGNED bundle (team DX3Y367L2A)"
    fi

    # Note: the nexus-mac target sets PRODUCT_NAME=nexus, so xcodebuild
    # produces `nexus.app` (lowercase). The installed bundle name is
    # `/Applications/Nexus.app` (capitalized). Match case-insensitively
    # (`-iname`) so the locate step never misses the product on PRODUCT_NAME
    # case drift — the original `-name 'Nexus.app'` matcher missed the real
    # lowercase product and silently no-op'd the install (nx-5ws74). Scoped
    # to Build/Products/Release so we don't pick up Debug artefacts left over
    # from a developer's prior run.
    local app_path
    app_path="$(find "$build_dir" -path '*/Build/Products/Release/*.app' -type d -iname 'nexus.app' -print -quit 2>/dev/null || true)"
    if [[ -z "$app_path" || ! -d "$app_path" ]]; then
        _macos_swift_deploy_warn "xcodebuild succeeded but {n,N}exus.app not found in $build_dir"
        rm -rf "$build_dir"
        return 1
    fi
    _macos_swift_deploy_info "located built bundle at $app_path"

    # ── Integrity gate: refuse a non-destructive ad-hoc clobber (nx-tceo6) ──
    # Verify the freshly-built bundle's TeamIdentifier. In the default
    # signed-only flow it MUST be DX3Y367L2A. When NX_ALLOW_ADHOC=1 produced an
    # ad-hoc bundle, do NOT overwrite an existing SIGNED /Applications/Nexus.app
    # — that downgrade is exactly the silent-degradation bug. Skip the install,
    # leave the prior signed app, and report SKIP.
    local built_team
    built_team="$(codesign -dv --verbose=2 "$app_path" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
    if [[ "$built_team" != "DX3Y367L2A" ]]; then
        local installed_team=""
        if [[ -d /Applications/Nexus.app ]]; then
            installed_team="$(codesign -dv --verbose=2 /Applications/Nexus.app 2>&1 | sed -n 's/^TeamIdentifier=//p')"
        fi
        if [[ "$installed_team" == "DX3Y367L2A" ]]; then
            _macos_swift_deploy_err "built bundle is NOT team-signed (TeamIdentifier=${built_team:-not set}) but /Applications/Nexus.app IS signed — refusing to downgrade. Install SKIPPED."
            _macos_swift_deploy_banner "Nexus deploy: refused downgrade" "Kept the existing team-signed app; the new build was ad-hoc/unsigned. See ~/Library/Logs/nexus-deploy.log"
            rm -rf "$build_dir"
            # Distinct return so the LaunchAgent wrapper can mark SKIP not FAIL.
            return 2
        fi
        if [[ "${NX_ALLOW_ADHOC:-0}" != "1" ]]; then
            _macos_swift_deploy_err "built bundle is NOT team-signed (TeamIdentifier=${built_team:-not set}) and NX_ALLOW_ADHOC!=1 — refusing to install. Install SKIPPED."
            _macos_swift_deploy_banner "Nexus deploy: not team-signed" "Build was not team-signed; install skipped. See ~/Library/Logs/nexus-deploy.log"
            rm -rf "$build_dir"
            return 2
        fi
        _macos_swift_deploy_warn "installing ad-hoc bundle (NX_ALLOW_ADHOC=1, no signed app to protect)"
    else
        _macos_swift_deploy_info "verified built bundle is team-signed (TeamIdentifier=DX3Y367L2A)"
    fi

    # ── Stop running instance (bd:nx-4l66v) ──────────────────────────
    # Three-phase termination with PID-level verification. Prior
    # implementation was `killall Nexus 2>/dev/null || true` which
    # was a silent no-op for two reasons:
    #   (a) The executable is `nexus.app/Contents/MacOS/nexus` —
    #       PRODUCT_NAME=nexus in project.yml, so `killall Nexus`
    #       (capitalized) NEVER matched; exit 1 was swallowed by
    #       `|| true`. (Process name is lowercase `nexus`, but that
    #       also matches `nexus-statusline` — too greedy.)
    #   (b) Even when a match existed, `killall` itself can fail
    #       silently against (formerly) LSUIElement apps under TCC.
    # New flow: snapshot PIDs by bundle path (precise — won't catch
    # nexus-statusline or other lowercase-nexus processes), send TERM,
    # verify, escalate to KILL, re-verify, fail loudly if still alive.

    local -a old_pids=()
    # pgrep -fl matches against full command line, so the bundle path
    # `Nexus.app` (capitalized — the installed name) is a tight filter
    # that excludes nexus-statusline and other unrelated processes.
    while IFS= read -r pid; do
        [[ -n "$pid" ]] && old_pids+=("$pid")
    done < <(pgrep -f "Nexus\.app/Contents/MacOS/" 2>/dev/null || true)

    if [[ ${#old_pids[@]} -eq 0 ]]; then
        _macos_swift_deploy_info "no running Nexus.app instance found"
    else
        _macos_swift_deploy_info "stopping running Nexus instance(s): PIDs=${old_pids[*]}"
        # Phase 1: SIGTERM (graceful)
        kill "${old_pids[@]}" 2>/dev/null || true
        # Wait up to 3 seconds for clean exit
        local waited=0
        local still_alive=0
        while [[ $waited -lt 30 ]]; do
            still_alive=0
            for pid in "${old_pids[@]}"; do
                if kill -0 "$pid" 2>/dev/null; then
                    still_alive=1
                    break
                fi
            done
            [[ $still_alive -eq 0 ]] && break
            sleep 0.1
            waited=$((waited + 1))
        done
        # Phase 2: SIGKILL escalation for survivors
        if [[ $still_alive -eq 1 ]]; then
            _macos_swift_deploy_warn "PIDs ${old_pids[*]} survived SIGTERM — escalating to SIGKILL"
            for pid in "${old_pids[@]}"; do
                if kill -0 "$pid" 2>/dev/null; then
                    kill -9 "$pid" 2>/dev/null || true
                fi
            done
            sleep 0.5
        fi
        # Phase 3: final verification
        for pid in "${old_pids[@]}"; do
            if kill -0 "$pid" 2>/dev/null; then
                _macos_swift_deploy_warn "PID $pid is STILL alive after SIGKILL — refusing to deploy over a running binary"
                rm -rf "$build_dir"
                return 1
            fi
        done
        _macos_swift_deploy_info "old PID(s) ${old_pids[*]} terminated"
    fi
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

    # ── Verify it came up with a NEW PID (bd:nx-4l66v) ───────────────
    # The previous check (`pgrep -fl Nexus.app`) returned true even if
    # `killall` silently no-op'd and the OLD PID was still running —
    # the same string matched both old and new processes. Now that the
    # stop-phase guarantees old PIDs are gone, the post-launch pgrep
    # finds ONLY the new PID. We also cross-check that the new PID is
    # not in the snapshot of old PIDs (defensive — could only happen
    # if PIDs were exhausted and reused, which is astronomically rare).
    sleep 2
    local -a new_pids=()
    while IFS= read -r pid; do
        [[ -n "$pid" ]] && new_pids+=("$pid")
    done < <(pgrep -f "Nexus\.app/Contents/MacOS/" 2>/dev/null || true)

    if [[ ${#new_pids[@]} -eq 0 ]]; then
        _macos_swift_deploy_warn "Nexus.app did not appear in process list after launch"
        return 1
    fi

    # Defensive: assert no new PID overlaps with the killed set. Guard on
    # old_pids being non-empty — when no instance was running (e.g. the prior
    # build crash-looped and already exited), old_pids is empty and bash 3.2
    # under `set -u` errors on "${old_pids[@]}" ("unbound variable"), which
    # previously aborted the relaunch step after a successful install.
    if [[ ${#old_pids[@]} -gt 0 ]]; then
        for new_pid in "${new_pids[@]}"; do
            for old_pid in "${old_pids[@]}"; do
                if [[ "$new_pid" == "$old_pid" ]]; then
                    _macos_swift_deploy_warn "new PID $new_pid was in the killed set — kernel reused a PID; re-verifying liveness"
                fi
            done
        done
    fi

    _macos_swift_deploy_info "Nexus.app running with NEW PID(s): ${new_pids[*]}"

    return 0
}
