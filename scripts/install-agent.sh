#!/usr/bin/env bash
set -euo pipefail

# Nexus Agent — install script (spec: add-agent-service-config)
# Detects OS, copies the nexus-agent binary to /usr/local/bin/,
# installs the appropriate service file, and enables/starts the service.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR/../deploy"
BINARY_NAME="nexus-agent"
REGISTER_BINARY="nexus-register"

info()  { printf '\033[1;34m==> %s\033[0m\n' "$1"; }
error() { printf '\033[1;31m==> %s\033[0m\n' "$1" >&2; exit 1; }

# ── Detect OS ──────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="macos" ;;
    *)      error "Unsupported OS: $OS" ;;
esac

info "Detected platform: $PLATFORM"

# ── Locate binary ─────────────────────────────────────────────────────
AGENT_BIN=""
for candidate in \
    "$DEPLOY_DIR/$BINARY_NAME" \
    "$SCRIPT_DIR/../target/release/$BINARY_NAME" \
    "$HOME/.local/bin/$BINARY_NAME"; do
    if [[ -f "$candidate" ]]; then
        AGENT_BIN="$candidate"
        break
    fi
done

[[ -z "$AGENT_BIN" ]] && error "Binary '$BINARY_NAME' not found. Build first with: cargo build --release"

# ── Copy binaries to /usr/local/bin/ ──────────────────────────────────
info "Installing $BINARY_NAME to /usr/local/bin/"
sudo install -m 755 "$AGENT_BIN" /usr/local/bin/$BINARY_NAME

# ── Locate and install nexus-register binary ─────────────────────────
REGISTER_BIN=""
for candidate in \
    "$DEPLOY_DIR/$REGISTER_BINARY" \
    "$SCRIPT_DIR/../apps/nexus-register/$REGISTER_BINARY" \
    "$HOME/.local/bin/$REGISTER_BINARY"; do
    if [[ -f "$candidate" ]]; then
        REGISTER_BIN="$candidate"
        break
    fi
done

if [[ -n "$REGISTER_BIN" ]]; then
    info "Installing $REGISTER_BINARY to /usr/local/bin/"
    sudo install -m 755 "$REGISTER_BIN" /usr/local/bin/$REGISTER_BINARY
else
    info "Skipping $REGISTER_BINARY (not found — build with: pnpm --filter @nexus/register build)"
fi

# ── Install service ────────────────────────────────────────────────────
if [[ "$PLATFORM" == "linux" ]]; then
    SERVICE_FILE="$DEPLOY_DIR/nexus-agent.service"
    [[ -f "$SERVICE_FILE" ]] || error "Missing $SERVICE_FILE"

    info "Installing systemd unit"
    sudo cp "$SERVICE_FILE" /etc/systemd/system/nexus-agent.service

    info "Reloading systemd daemon"
    sudo systemctl daemon-reload

    info "Enabling and starting nexus-agent"
    sudo systemctl enable nexus-agent
    sudo systemctl start nexus-agent

    info "Done. Check status with: systemctl status nexus-agent"

elif [[ "$PLATFORM" == "macos" ]]; then
    PLIST_FILE="$DEPLOY_DIR/com.nexus.agent.plist"
    [[ -f "$PLIST_FILE" ]] || error "Missing $PLIST_FILE"

    LAUNCH_DIR="$HOME/Library/LaunchAgents"
    mkdir -p "$LAUNCH_DIR"

    info "Installing launchd plist"
    # Replace ${USER} placeholder with actual username
    sed "s|\${USER}|$USER|g" "$PLIST_FILE" > "$LAUNCH_DIR/com.nexus.agent.plist"

    info "Loading launchd agent"
    launchctl load "$LAUNCH_DIR/com.nexus.agent.plist"

    info "Done. Check logs at: ~/Library/Logs/nexus-agent.stdout.log"
fi
