#!/usr/bin/env bash
set -euo pipefail

# Nexus — installation script (Bun v4)
# Builds the Bun binaries, installs them, and installs the service files
# and git-hook dispatchers.
#
# Usage:
#   deploy/install.sh                    # build + install agent (+ nexus-statusline if present)
#   deploy/install.sh --dashboard        # also install Next.js dashboard service + Traefik config
#   deploy/install.sh --no-build         # skip build, install pre-built binaries from apps/*/
#
# Mac listener install: handled automatically by the post-merge git deploy
# hook (deploy/hooks.d/post-merge/02-deploy), which fans out to every Mac
# listed in ~/.config/nexus/agents.toml and installs deploy/nexus-notifier.sh
# + deploy/com.nexus.notifier.plist over SSH. There is no separate --mac
# entry point — pulling main on the Linux host is the install path.
#
# Environment variables:
#   TRAEFIK_DYNAMIC_DIR   Directory Traefik watches for dynamic config (default: /etc/traefik/dynamic)

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

if $DO_BUILD && ! command -v bun &>/dev/null; then
    error "bun is required for building. Install from https://bun.sh or pass --no-build."
fi

OS="$(uname -s)"
case "$OS" in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="macos" ;;
    *)      error "Unsupported OS: $OS" ;;
esac

info "Detected platform: $PLATFORM"

# ── Build binaries ──────────────────────────────────────────────────

if $DO_BUILD; then
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

# ── Locate binaries ─────────────────────────────────────────────────

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

# ── Install binaries ────────────────────────────────────────────────

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

# ── Create config directory ─────────────────────────────────────────

if [[ ! -d "$CONFIG_DIR" ]]; then
    info "Creating config directory: $CONFIG_DIR"
    mkdir -p "$CONFIG_DIR"
fi

# ── Install service file ────────────────────────────────────────────

if [[ "$PLATFORM" == "linux" ]]; then
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_DIR"

    info "Installing systemd user service"
    install -m 644 "$SCRIPT_DIR/nexus-agent.service" "$SYSTEMD_DIR/nexus-agent.service"

    echo ""
    info "Installation complete. Next steps:"
    echo "  systemctl --user daemon-reload"
    echo "  systemctl --user enable --now nexus-agent"
    echo "  journalctl --user -u nexus-agent -f     # view logs"

elif [[ "$PLATFORM" == "macos" ]]; then
    LAUNCH_DIR="$HOME/Library/LaunchAgents"
    mkdir -p "$LAUNCH_DIR"

    info "Installing launchd user agent"
    sed "s|\${USER}|$USER|g" "$SCRIPT_DIR/com.nexus.agent.plist" > "$LAUNCH_DIR/com.nexus.agent.plist"

    echo ""
    info "Installation complete. Next steps:"
    echo "  launchctl bootout gui/\$(id -u)/com.nexus.agent 2>/dev/null || true"
    echo "  launchctl load ~/Library/LaunchAgents/com.nexus.agent.plist"
    echo "  tail -f ~/Library/Logs/nexus-agent.stdout.log   # view logs"
fi

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

# ── Dashboard install (--dashboard flag) ───────────────────────────

if $INSTALL_DASHBOARD; then
    echo ""
    info "Installing Nexus Dashboard"

    if [[ "$PLATFORM" == "linux" ]]; then
        SYSTEMD_DIR="$HOME/.config/systemd/user"
        mkdir -p "$SYSTEMD_DIR"
        install -m 644 "$SCRIPT_DIR/nexus-dashboard.service" "$SYSTEMD_DIR/nexus-dashboard.service"
        info "Installed nexus-dashboard.service to $SYSTEMD_DIR/"
    else
        warn "Dashboard systemd service is Linux-only. Skipping service install on $PLATFORM."
    fi

    if [[ -d "$TRAEFIK_DYNAMIC_DIR" ]]; then
        install -m 644 "$SCRIPT_DIR/traefik/nexus-dashboard.yml" "$TRAEFIK_DYNAMIC_DIR/nexus-dashboard.yml"
        info "Installed Traefik config to $TRAEFIK_DYNAMIC_DIR/nexus-dashboard.yml"
    else
        warn "Traefik dynamic dir not found: $TRAEFIK_DYNAMIC_DIR"
        warn "Create it or set TRAEFIK_DYNAMIC_DIR and re-run, then copy manually:"
        warn "  cp $SCRIPT_DIR/traefik/nexus-dashboard.yml $TRAEFIK_DYNAMIC_DIR/"
    fi

    echo ""
    printf '\033[1;33m━━━ Dashboard Pre-flight ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m\n'
    printf '\033[1;33m  REQUIRED: build the Next.js app before enabling the service\033[0m\n'
    printf '\033[1;33m\033[0m\n'
    printf '\033[1;33m  cd ~/dev/nx && git pull\033[0m\n'
    printf '\033[1;33m  cd apps/nextjs && pnpm build\033[0m\n'
    printf '\033[1;33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m\n'
    echo ""
    info "Dashboard next steps:"
    echo "  systemctl --user daemon-reload"
    echo "  systemctl --user enable --now nexus-dashboard"
    echo "  journalctl --user -u nexus-dashboard -f    # view logs"
    echo "  curl http://localhost:3100                  # verify running"
    echo ""
    echo "  Set NEXUS_AGENTS in ~/.env to connect to your agents:"
    echo '  NEXUS_AGENTS="homelab:homelab:7400,macbook:macbook:7400"'
fi
