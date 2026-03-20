#!/usr/bin/env bash
set -euo pipefail

# Nexus Agent — installation script
# Copies pre-built binaries and installs the appropriate service file.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/nexus"

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
    cp "$SCRIPT_DIR/hooks/post-merge" "$REPO_DIR/.git/hooks/post-merge"
    cp "$SCRIPT_DIR/hooks/pre-push" "$REPO_DIR/.git/hooks/pre-push"
    chmod +x "$REPO_DIR/.git/hooks/post-merge" "$REPO_DIR/.git/hooks/pre-push"
else
    warn "Not a git repository — skipping hook installation"
fi

echo ""
info "Config directory: $CONFIG_DIR"
info "Edit $CONFIG_DIR/agents.toml to register remote agents."
