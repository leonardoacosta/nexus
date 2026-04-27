#!/usr/bin/env bash
set -euo pipefail

# Nexus — installation script (Bun v4)
# Builds the Bun binaries, installs them, and installs the service files
# and git-hook dispatchers.
#
# Usage:
#   deploy/install.sh                    # build + install agent (+ nexus-register if present)
#   deploy/install.sh --dashboard        # also install Next.js dashboard service + Traefik config
#   deploy/install.sh --no-build         # skip build, install pre-built binaries from apps/*/
#   deploy/install.sh --mac [host]       # ship Mac listener (script + plist) to a remote Mac via ssh/scp
#
# Environment variables:
#   TRAEFIK_DYNAMIC_DIR   Directory Traefik watches for dynamic config (default: /etc/traefik/dynamic)
#   MAC_HOST              Default Mac target for --mac (overridden by positional arg)
#   MAC_USER              SSH user for the Mac (default: $USER)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/nexus"
TRAEFIK_DYNAMIC_DIR="${TRAEFIK_DYNAMIC_DIR:-/etc/traefik/dynamic}"
INSTALL_DASHBOARD=false
DO_BUILD=true
INSTALL_MAC=false
MAC_HOST_ARG=""

# We hand-roll arg parsing because --mac takes an optional positional
# (the target host) and `case` over $@ collapses positionals into "$arg".
i=1
while [[ $i -le $# ]]; do
    arg="${!i}"
    case "$arg" in
        --dashboard) INSTALL_DASHBOARD=true ;;
        --no-build)  DO_BUILD=false ;;
        --mac)
            INSTALL_MAC=true
            # Peek at the next arg; if it doesn't start with `--` treat it
            # as the Mac hostname.
            next_i=$((i + 1))
            if [[ $next_i -le $# ]]; then
                next="${!next_i}"
                if [[ "$next" != --* ]]; then
                    MAC_HOST_ARG="$next"
                    i=$next_i
                fi
            fi
            ;;
        *) ;;
    esac
    i=$((i + 1))
done

info()  { printf '\033[1;34m==> %s\033[0m\n' "$1"; }
warn()  { printf '\033[1;33m==> %s\033[0m\n' "$1"; }
error() { printf '\033[1;31m==> %s\033[0m\n' "$1" >&2; exit 1; }

# ── Mac listener install (--mac) ────────────────────────────────────
#
# Ships deploy/mac/nexus-notifier.sh + com.nexus.notifier.plist to a
# remote Mac and bootstraps launchd. Run this from the Linux host that
# owns the agent — we don't expect anyone to run install.sh ON the Mac
# itself.
#
# Resolution order for the target host:
#   1. Positional argument after --mac
#   2. $MAC_HOST environment variable
#   3. Hard error
#
# Required on the Mac side (caller must have provisioned in advance):
#   - SSH access via key; this script does not prompt for passwords.
#   - $HOME/bin on PATH (we install the script there to match Leo's
#     existing layout — see ~/Library/LaunchAgents/com.nexus.notifier.plist).
#   - $HOME/.env containing NEXUS_ATTACH_SECRET (the listener fail-closes
#     when this isn't set; see deploy/mac/nexus-notifier.sh).
#
if $INSTALL_MAC; then
    MAC_HOST="${MAC_HOST_ARG:-${MAC_HOST:-}}"
    MAC_USER="${MAC_USER:-$USER}"
    MAC_TARGET=""

    if [[ -z "$MAC_HOST" ]]; then
        error "--mac requires a target host. Pass as positional arg or set MAC_HOST."
    fi

    # `user@host` if MAC_USER differs from local $USER, else just host.
    if [[ "$MAC_USER" != "$USER" ]]; then
        MAC_TARGET="$MAC_USER@$MAC_HOST"
    else
        MAC_TARGET="$MAC_HOST"
    fi

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    MAC_SCRIPT="$SCRIPT_DIR/mac/nexus-notifier.sh"
    MAC_PLIST="$SCRIPT_DIR/mac/com.nexus.notifier.plist"

    [[ -f "$MAC_SCRIPT" ]] || error "Missing $MAC_SCRIPT — has the spec landed?"
    [[ -f "$MAC_PLIST"  ]] || error "Missing $MAC_PLIST — has the spec landed?"

    info "Installing Mac listener to $MAC_TARGET"

    # Ensure $HOME/bin and $HOME/Library/LaunchAgents exist before we scp.
    ssh "$MAC_TARGET" 'mkdir -p "$HOME/bin" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"' \
        || error "ssh preflight failed against $MAC_TARGET"

    info "scp $MAC_SCRIPT -> $MAC_TARGET:~/bin/nexus-notifier.sh"
    scp -q "$MAC_SCRIPT" "$MAC_TARGET":'~/bin/nexus-notifier.sh' \
        || error "scp of nexus-notifier.sh failed"
    ssh "$MAC_TARGET" 'chmod +x "$HOME/bin/nexus-notifier.sh"' \
        || error "chmod nexus-notifier.sh failed"

    info "scp $MAC_PLIST -> $MAC_TARGET:~/Library/LaunchAgents/com.nexus.notifier.plist"
    scp -q "$MAC_PLIST" "$MAC_TARGET":'~/Library/LaunchAgents/com.nexus.notifier.plist' \
        || error "scp of com.nexus.notifier.plist failed"

    info "Bootstrapping launchctl on $MAC_TARGET"
    # Unload first to clear any prior version, then load. We tolerate the
    # unload failing (no prior install) but require load to succeed.
    ssh "$MAC_TARGET" '
        launchctl unload "$HOME/Library/LaunchAgents/com.nexus.notifier.plist" 2>/dev/null || true
        launchctl load "$HOME/Library/LaunchAgents/com.nexus.notifier.plist"
    ' || error "launchctl load failed on $MAC_TARGET"

    info "Mac listener installed. Verify with:"
    echo "  ssh $MAC_TARGET 'tail -f ~/Library/Logs/nexus-notifier.log'"
    echo "  ssh $MAC_TARGET 'launchctl list | grep com.nexus.notifier'"
    exit 0
fi

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

    if [[ -d "$REPO_DIR/apps/nexus-register" ]]; then
        info "Building @nexus/register"
        (cd "$REPO_DIR/apps/nexus-register" && bun run build) || error "apps/nexus-register build failed"
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

if [[ -f "$REPO_DIR/apps/nexus-register/nexus-register" ]]; then
    info "Installing nexus-register to $BIN_DIR/"
    install -m 755 "$REPO_DIR/apps/nexus-register/nexus-register" "$BIN_DIR/nexus-register"
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
