#!/usr/bin/env bash
set -euo pipefail

# Nexus — environment-aware installer.
#
# Detects host platform via `uname -s` and branches:
#   Darwin  -> build Swift dashboard (xcodegen + xcodebuild) + install agent
#             binary + launchd plist for nexus-agent
#   Linux   -> build agent binary (bun --compile), install to ~/.local/bin,
#             write systemd user unit, daemon-reload + enable
#
# Usage:
#   deploy/install.sh                # build + install for current platform
#   deploy/install.sh --no-build     # skip build; install pre-built binaries
#   deploy/install.sh --dashboard    # (Linux only) also install Traefik proxy
#                                    # for the legacy dashboard service. Kept
#                                    # for hosts still serving the Next.js
#                                    # admin; new installs should rely on the
#                                    # Swift dashboard instead.
#
# This script is the single entry point. The post-merge git hook
# (deploy/hooks.d/post-merge/02-deploy) calls into it for managed deploys.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/nexus"
TRAEFIK_DYNAMIC_DIR="${TRAEFIK_DYNAMIC_DIR:-/etc/traefik/dynamic}"
INSTALL_DASHBOARD=false
DO_BUILD=true

for arg in "$@"; do
    case "$arg" in
        --dashboard) INSTALL_DASHBOARD=true ;;
        --no-build)  DO_BUILD=false ;;
        *) ;;
    esac
done

info()  { printf '\033[1;34m==> %s\033[0m\n' "$1"; }
warn()  { printf '\033[1;33m==> %s\033[0m\n' "$1"; }
error() { printf '\033[1;31m==> %s\033[0m\n' "$1" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────

if ! command -v tmux &>/dev/null; then
    error "tmux is required but not found on PATH. Install it first (e.g. apt install tmux / brew install tmux)."
fi

OS="$(uname -s)"
case "$OS" in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="macos" ;;
    *)      error "Unsupported OS: $OS" ;;
esac

info "Detected platform: $PLATFORM"

# ── Shared: build + install nexus-agent binary ──────────────────────
#
# The agent (apps/agent) is the only Bun binary required on both
# platforms — it watches sessions.json and exposes the socket API.

if $DO_BUILD; then
    if ! command -v bun &>/dev/null; then
        error "bun is required for building. Install from https://bun.sh or pass --no-build."
    fi

    info "Building @nexus/agent (bun build --compile)"
    (cd "$REPO_DIR/apps/agent" && bun run build) || error "apps/agent build failed"

    if [[ -d "$REPO_DIR/apps/nexus-statusline" ]]; then
        info "Building @nexus/statusline"
        (cd "$REPO_DIR/apps/nexus-statusline" && bun run build) || error "apps/nexus-statusline build failed"
    fi

    if [[ -d "$REPO_DIR/apps/nexus-emit" ]]; then
        info "Building @nexus/emit (deploy/hook socket helper)"
        (cd "$REPO_DIR/apps/nexus-emit" && bun run build) || error "apps/nexus-emit build failed"
    fi
fi

find_binary() {
    local name="$1"
    local subdir="$2"
    local path="$REPO_DIR/apps/$subdir/$name"
    if [[ -f "$path" ]]; then
        echo "$path"
    else
        error "Binary '$name' not found at $path. Build first (omit --no-build)."
    fi
}

AGENT_BIN="$(find_binary nexus-agent agent)"

mkdir -p "$BIN_DIR"
info "Installing nexus-agent to $BIN_DIR/"
install -m 755 "$AGENT_BIN" "$BIN_DIR/nexus-agent"

if [[ -f "$REPO_DIR/apps/nexus-statusline/nexus-statusline" ]]; then
    info "Installing nexus-statusline to $BIN_DIR/"
    install -m 755 "$REPO_DIR/apps/nexus-statusline/nexus-statusline" "$BIN_DIR/nexus-statusline"
fi

if [[ -f "$REPO_DIR/apps/nexus-emit/nexus-emit" ]]; then
    info "Installing nexus-emit to $BIN_DIR/"
    install -m 755 "$REPO_DIR/apps/nexus-emit/nexus-emit" "$BIN_DIR/nexus-emit"
fi

mkdir -p "$CONFIG_DIR"

# ── Platform branches ───────────────────────────────────────────────

install_linux() {
    local SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_DIR"

    info "Installing systemd user service"
    install -m 644 "$SCRIPT_DIR/nexus-agent.service" "$SYSTEMD_DIR/nexus-agent.service"

    systemctl --user daemon-reload || warn "systemctl daemon-reload failed (run manually)"
    systemctl --user enable nexus-agent || warn "systemctl enable failed (run manually)"

    echo ""
    info "Linux install complete. Next steps:"
    echo "  systemctl --user start nexus-agent"
    echo "  journalctl --user -u nexus-agent -f     # view logs"
}

install_macos() {
    # Swift dashboard build — xcodegen generates the .xcodeproj from
    # apps/swift/project.yml, then xcodebuild produces nexus.app.
    if $DO_BUILD; then
        if ! command -v xcodegen &>/dev/null; then
            warn "xcodegen not found — skipping Swift dashboard build."
            warn "Install: brew install xcodegen"
        elif ! command -v xcodebuild &>/dev/null; then
            warn "xcodebuild not found — Xcode CLT required for Swift build."
        else
            info "Regenerating Xcode project (xcodegen)"
            (cd "$REPO_DIR/apps/swift" && xcodegen generate) \
                || warn "xcodegen generate failed — continuing without Swift build"

            info "Building Nexus.app (Release scheme: nexus-mac)"
            local BUILD_DIR
            BUILD_DIR="$(mktemp -d)"
            if (cd "$REPO_DIR/apps/swift" && xcodebuild \
                    -project nexus.xcodeproj \
                    -scheme nexus-mac \
                    -configuration Release \
                    -derivedDataPath "$BUILD_DIR" \
                    CODE_SIGN_IDENTITY="" \
                    CODE_SIGNING_REQUIRED=NO \
                    CODE_SIGNING_ALLOWED=NO \
                    build 2>&1 | tail -20); then
                local APP_PATH
                APP_PATH="$(find "$BUILD_DIR" -name 'Nexus.app' -type d -print -quit 2>/dev/null || true)"
                if [[ -n "$APP_PATH" && -d "$APP_PATH" ]]; then
                    if [[ -w /Applications ]] || [[ -w /Applications/Nexus.app ]] 2>/dev/null; then
                        info "Installing Nexus.app to /Applications"
                        rm -rf /Applications/Nexus.app
                        cp -R "$APP_PATH" /Applications/Nexus.app
                    else
                        warn "/Applications is not writable. Copy manually:"
                        warn "  sudo cp -R $APP_PATH /Applications/Nexus.app"
                    fi
                else
                    warn "xcodebuild succeeded but Nexus.app not found in $BUILD_DIR"
                fi
                rm -rf "$BUILD_DIR"
            else
                warn "xcodebuild failed — Swift dashboard not installed. Continuing with agent install."
                rm -rf "$BUILD_DIR"
            fi
        fi
    fi

    # Agent launchd plist — generate inline. The plist file used to live
    # at deploy/com.nexus.agent.plist; it was removed by
    # remove-mac-deploy-artifacts so installs no longer depend on a
    # checked-in plist that drifts from $USER / $HOME.
    local LAUNCH_DIR="$HOME/Library/LaunchAgents"
    local PLIST="$LAUNCH_DIR/com.nexus.agent.plist"
    mkdir -p "$LAUNCH_DIR"

    info "Generating launchd user agent at $PLIST"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nexus.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BIN_DIR/nexus-agent</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/nexus-agent.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/nexus-agent.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>RUST_LOG</key>
        <string>info</string>
        <key>PATH</key>
        <string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST

    # TODO: optional login item registration for Nexus.app via
    # `osascript -e 'tell application "System Events" to make login item ...'`.
    # Skipped for now — manual via System Settings -> Login Items. See nx-eop6z
    # for the related Mac TTS / launchd cleanup work.

    echo ""
    info "macOS install complete. Next steps:"
    echo "  launchctl bootout gui/\$(id -u)/com.nexus.agent 2>/dev/null || true"
    echo "  launchctl bootstrap gui/\$(id -u) $PLIST"
    echo "  tail -f ~/Library/Logs/nexus-agent.stdout.log   # view logs"
    if [[ -d /Applications/Nexus.app ]]; then
        echo "  open /Applications/Nexus.app                    # launch dashboard"
    fi
}

case "$PLATFORM" in
    linux)  install_linux ;;
    macos)  install_macos ;;
esac

# ── Install git hook dispatchers ───────────────────────────────────

if [[ -d "$REPO_DIR/.git" ]]; then
    info "Installing git hook dispatchers"
    install -m 755 "$SCRIPT_DIR/hooks/post-merge-dispatcher" "$REPO_DIR/.git/hooks/post-merge"
    install -m 755 "$SCRIPT_DIR/hooks/pre-push-dispatcher" "$REPO_DIR/.git/hooks/pre-push"
else
    warn "Not a git repository — skipping hook installation"
fi

echo ""
info "Config directory: $CONFIG_DIR"

# ── Dashboard install (--dashboard flag, Linux only) ───────────────
#
# Kept for legacy Next.js dashboard hosts. The Swift dashboard is the
# canonical UI going forward; this branch is for hosts that still serve
# the web admin over Traefik.

if $INSTALL_DASHBOARD; then
    if [[ "$PLATFORM" != "linux" ]]; then
        warn "--dashboard is Linux-only. Skipping on $PLATFORM."
    else
        echo ""
        info "Installing legacy Nexus Dashboard (Linux + Traefik)"

        SYSTEMD_DIR="$HOME/.config/systemd/user"
        mkdir -p "$SYSTEMD_DIR"
        if [[ -f "$SCRIPT_DIR/nexus-dashboard.service" ]]; then
            install -m 644 "$SCRIPT_DIR/nexus-dashboard.service" "$SYSTEMD_DIR/nexus-dashboard.service"
            info "Installed nexus-dashboard.service to $SYSTEMD_DIR/"
        else
            warn "nexus-dashboard.service not present — legacy dashboard retired."
        fi

        if [[ -d "$TRAEFIK_DYNAMIC_DIR" && -f "$SCRIPT_DIR/traefik/nexus-dashboard.yml" ]]; then
            install -m 644 "$SCRIPT_DIR/traefik/nexus-dashboard.yml" "$TRAEFIK_DYNAMIC_DIR/nexus-dashboard.yml"
            info "Installed Traefik config to $TRAEFIK_DYNAMIC_DIR/nexus-dashboard.yml"
        else
            warn "Traefik dynamic dir or config not found — skipping reverse proxy install."
        fi
    fi
fi
