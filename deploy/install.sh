#!/usr/bin/env bash
set -euo pipefail

# Nexus — installation script
# Copies pre-built binaries and installs the appropriate service files.
#
# Usage:
#   deploy/install.sh                    # install agent + TUI (default)
#   deploy/install.sh --dashboard        # also install Next.js dashboard service + Traefik config
#
# Environment variables:
#   TRAEFIK_DYNAMIC_DIR   Directory Traefik watches for dynamic config (default: /etc/traefik/dynamic)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/nexus"
TRAEFIK_DYNAMIC_DIR="${TRAEFIK_DYNAMIC_DIR:-/etc/traefik/dynamic}"
INSTALL_DASHBOARD=false

# Parse flags
for arg in "$@"; do
    case "$arg" in
        --dashboard) INSTALL_DASHBOARD=true ;;
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

if ! command -v protoc &>/dev/null; then
    error "protoc is required but not found on PATH. Install it first (e.g. apt install protobuf-compiler / brew install protobuf)."
fi

OS="$(uname -s)"
case "$OS" in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="macos" ;;
    *)      error "Unsupported OS: $OS" ;;
esac

info "Detected platform: $PLATFORM"

# ── Locate binaries ─────────────────────────────────────────────────

# Look for pre-built binaries next to this script, then fall back to
# the workspace release directory.
find_binary() {
    local name="$1"
    if [[ -f "$SCRIPT_DIR/$name" ]]; then
        echo "$SCRIPT_DIR/$name"
    elif [[ -f "$SCRIPT_DIR/../target/release/$name" ]]; then
        echo "$SCRIPT_DIR/../target/release/$name"
    else
        error "Binary '$name' not found. Build first with: cargo build --release"
    fi
}

AGENT_BIN="$(find_binary nexus-agent)"
TUI_BIN="$(find_binary nexus)"

# ── Install binaries ────────────────────────────────────────────────

mkdir -p "$BIN_DIR"

info "Installing nexus-agent to $BIN_DIR/"
install -m 755 "$AGENT_BIN" "$BIN_DIR/nexus-agent"

info "Installing nexus (TUI) to $BIN_DIR/"
install -m 755 "$TUI_BIN" "$BIN_DIR/nexus"

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
    # Replace ${USER} placeholder with the actual username
    sed "s|\${USER}|$USER|g" "$SCRIPT_DIR/com.nexus.agent.plist" > "$LAUNCH_DIR/com.nexus.agent.plist"

    echo ""
    info "Installation complete. Next steps:"
    echo "  launchctl load ~/Library/LaunchAgents/com.nexus.agent.plist"
    echo "  tail -f ~/Library/Logs/nexus-agent.stdout.log   # view logs"
fi

# ── Install git hooks ──────────────────────────────────────────────

REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -d "$REPO_DIR/.git" ]]; then
    info "Installing git hooks"
    cp "$SCRIPT_DIR/hooks/post-merge-dispatcher" "$REPO_DIR/.git/hooks/post-merge"
    cp "$SCRIPT_DIR/hooks/pre-push-dispatcher" "$REPO_DIR/.git/hooks/pre-push"
    chmod +x "$REPO_DIR/.git/hooks/post-merge" "$REPO_DIR/.git/hooks/pre-push"
else
    warn "Not a git repository — skipping hook installation"
fi

echo ""
info "Config directory: $CONFIG_DIR"
info "Edit $CONFIG_DIR/agents.toml to register remote agents."

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

    # Install Traefik dynamic config
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
