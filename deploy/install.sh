#!/usr/bin/env bash
set -euo pipefail

# Nexus — environment-aware installer.
#
# Detects host platform via `uname -s` and branches:
#   Darwin  -> build Swift dashboard (xcodegen + xcodebuild); no agent
#             daemon (spine model: Mac is Swift app + Tailnet only)
#   Linux   -> build agent binary (bun --compile), install to ~/.local/bin,
#             write systemd user unit, daemon-reload + enable
#
# Usage:
#   deploy/install.sh                  # build + install for current platform
#   deploy/install.sh --no-build       # skip build; install pre-built binaries
#   deploy/install.sh --homelab-deploy # install the self-deploy timer (Linux homelab)
#
# This script is the single entry point. The post-merge git hook
# (deploy/hooks.d/post-merge/02-deploy) calls into it for managed deploys.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/nexus"
DO_BUILD=true
DO_HOMELAB_DEPLOY=false

for arg in "$@"; do
    case "$arg" in
        --no-build)        DO_BUILD=false ;;
        --homelab-deploy)  DO_HOMELAB_DEPLOY=true ;;
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

# ── Standalone homelab-deploy fast path ─────────────────────────────
#
# `deploy/install.sh --homelab-deploy` installs ONLY the self-deploy
# timer (no agent rebuild) and exits. Useful for re-provisioning the
# timer without touching the running agent. The full Linux install path
# also installs the timer (see install_linux) — this branch is the
# narrow, no-build entry point. Linux only.

if $DO_HOMELAB_DEPLOY; then
    if [[ "$PLATFORM" != "linux" ]]; then
        error "--homelab-deploy is Linux-only (the homelab runs the agent daemon)."
    fi
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_DIR" "$BIN_DIR"

    info "Installing homelab self-deploy script to $BIN_DIR/nexus-homelab-deploy"
    install -m 755 "$SCRIPT_DIR/deploy-homelab.sh" "$BIN_DIR/nexus-homelab-deploy"

    info "Installing homelab self-deploy systemd units"
    install -m 644 "$SCRIPT_DIR/nexus-homelab-deploy.service" "$SYSTEMD_DIR/nexus-homelab-deploy.service"
    install -m 644 "$SCRIPT_DIR/nexus-homelab-deploy.timer"   "$SYSTEMD_DIR/nexus-homelab-deploy.timer"

    systemctl --user daemon-reload || warn "systemctl daemon-reload failed (run manually)"
    systemctl --user enable --now nexus-homelab-deploy.timer \
        || warn "systemctl enable --now nexus-homelab-deploy.timer failed (run manually)"

    echo ""
    info "Homelab self-deploy timer installed. Inspect with:"
    echo "  systemctl --user status nexus-homelab-deploy.timer"
    echo "  journalctl --user -u nexus-homelab-deploy.service -f"
    exit 0
fi

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

# Install the homelab self-deploy timer (Linux only). Idempotent.
#
# Drops deploy/deploy-homelab.sh at a STABLE path (~/.local/bin/) so the
# timer can run it even while the repo checkout is mid-pull, copies the
# service + timer units to ~/.config/systemd/user/, reloads systemd, and
# enables the timer. The deploy script itself is a cheap no-op when the
# repo is already at origin/main.
install_homelab_deploy() {
    local SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_DIR" "$BIN_DIR"

    info "Installing homelab self-deploy script to $BIN_DIR/nexus-homelab-deploy"
    install -m 755 "$SCRIPT_DIR/deploy-homelab.sh" "$BIN_DIR/nexus-homelab-deploy"

    info "Installing homelab self-deploy systemd units"
    install -m 644 "$SCRIPT_DIR/nexus-homelab-deploy.service" "$SYSTEMD_DIR/nexus-homelab-deploy.service"
    install -m 644 "$SCRIPT_DIR/nexus-homelab-deploy.timer"   "$SYSTEMD_DIR/nexus-homelab-deploy.timer"

    systemctl --user daemon-reload || warn "systemctl daemon-reload failed (run manually)"
    systemctl --user enable --now nexus-homelab-deploy.timer \
        || warn "systemctl enable --now nexus-homelab-deploy.timer failed (run manually)"

    info "Homelab self-deploy timer enabled. Inspect with:"
    echo "  systemctl --user status nexus-homelab-deploy.timer"
    echo "  journalctl --user -u nexus-homelab-deploy.service -f"
}

# ── macOS GUI-session deploy agent (nx-tceo6) ────────────────────────
# Installs + (re)loads dev.leonardoacosta.nexus.deploy into the user's GUI
# launchd domain so the SSH-triggered git hook can kickstart a SIGNED build in
# the Aqua session. Idempotent: bootout (tolerate not-loaded) then bootstrap.
install_macos_deploy_agent() {
    local label="dev.leonardoacosta.nexus.deploy"
    local src="$SCRIPT_DIR/$label.plist"
    local dst="$HOME/Library/LaunchAgents/$label.plist"
    local uid; uid="$(id -u)"

    if [[ ! -f "$src" ]]; then
        warn "deploy LaunchAgent plist not found at $src — skipping GUI deploy agent install"
        return 0
    fi

    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" \
             "$HOME/Library/Application Support/Nexus"
    install -m 644 "$src" "$dst"
    chmod 755 "$SCRIPT_DIR/lib/macos-deploy-agent.sh" 2>/dev/null || true

    info "Loading GUI deploy agent ($label) into gui/$uid"
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    if launchctl bootstrap "gui/$uid" "$dst" >/dev/null 2>&1; then
        info "GUI deploy agent loaded. The SSH-triggered hook will kickstart it for signed builds."
    else
        warn "launchctl bootstrap gui/$uid $dst failed — load manually inside the GUI session:"
        echo "  launchctl bootout gui/$uid/$label 2>/dev/null; launchctl bootstrap gui/$uid \"$dst\""
    fi
    echo "  log: ~/Library/Logs/nexus-deploy.log    marker: ~/Library/Application Support/Nexus/deploy-status.txt"
}

# ── iOS GUI-session device deploy agent (nx-tceo6 iOS Aqua bridge) ───
# Sibling of install_macos_deploy_agent for iOS DEVICE installs. A signed iOS
# build over plain SSH lands in a non-Aqua session where the team identity
# fails (errSecInternalComponent); this agent runs the signed build +
# `devicectl device install` in the Aqua session. The SSH-side
# deploy/ios-deploy.sh kickstarts it (gui/501, no sudo) and polls the marker.
install_ios_deploy_agent() {
    local label="dev.leonardoacosta.nexus.ios-deploy"
    local src="$SCRIPT_DIR/launchagents/$label.plist"
    local dst="$HOME/Library/LaunchAgents/$label.plist"
    local uid; uid="$(id -u)"

    if [[ ! -f "$src" ]]; then
        warn "iOS deploy LaunchAgent plist not found at $src — skipping iOS deploy agent install"
        return 0
    fi

    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" \
             "$HOME/Library/Application Support/Nexus"
    install -m 644 "$src" "$dst"
    chmod 755 "$SCRIPT_DIR/lib/ios-deploy-agent.sh" \
              "$SCRIPT_DIR/lib/ios-device-deploy.sh" \
              "$SCRIPT_DIR/ios-deploy.sh" 2>/dev/null || true

    info "Loading GUI iOS deploy agent ($label) into gui/$uid"
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    if launchctl bootstrap "gui/$uid" "$dst" >/dev/null 2>&1; then
        info "GUI iOS deploy agent loaded. deploy/ios-deploy.sh will kickstart it for signed device installs."
    else
        warn "launchctl bootstrap gui/$uid $dst failed — load manually inside the GUI session:"
        echo "  launchctl bootout gui/$uid/$label 2>/dev/null; launchctl bootstrap gui/$uid \"$dst\""
    fi
    echo "  log: ~/Library/Logs/nexus-ios-deploy.log    marker: ~/Library/Application Support/Nexus/ios-deploy-status.txt"
}

# ── macOS presence sensor agent (mac-presence-observer, Phase 1.5) ───
# Installs + (re)loads dev.leonardoacosta.nexus.presence into the user's GUI
# launchd domain. Unlike the deploy agents this is ALWAYS-ON (RunAtLoad +
# KeepAlive): a headless sensor that POSTs presence to the local agent. It MUST
# run in gui/501 for CMIO camera/mic reads. The nexus-presence BINARY is built +
# installed by macos_swift_deploy_run (deploy/lib/macos-swift-deploy.sh); this
# only loads the LaunchAgent. Idempotent: bootout (tolerate not-loaded) then
# bootstrap.
install_presence_agent() {
    local label="dev.leonardoacosta.nexus.presence"
    local src="$SCRIPT_DIR/launchagents/$label.plist"
    local dst="$HOME/Library/LaunchAgents/$label.plist"
    local uid; uid="$(id -u)"

    if [[ ! -f "$src" ]]; then
        warn "presence LaunchAgent plist not found at $src — skipping presence agent install"
        return 0
    fi

    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" \
             "$HOME/Library/Application Support/Nexus/bin"
    install -m 644 "$src" "$dst"

    if [[ ! -x "$HOME/Library/Application Support/Nexus/bin/nexus-presence" ]]; then
        warn "nexus-presence binary not yet installed — it lands on the next Swift deploy (macos_swift_deploy_run)."
    fi

    info "Loading presence sensor agent ($label) into gui/$uid"
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    if launchctl bootstrap "gui/$uid" "$dst" >/dev/null 2>&1; then
        info "Presence sensor loaded (RunAtLoad + KeepAlive). It POSTs to the local agent's /presence/report."
    else
        warn "launchctl bootstrap gui/$uid $dst failed — load manually inside the GUI session:"
        echo "  launchctl bootout gui/$uid/$label 2>/dev/null; launchctl bootstrap gui/$uid \"$dst\""
    fi
    echo "  log: ~/Library/Logs/nexus-presence.log"
}

install_linux() {
    local SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_DIR"

    info "Installing systemd user service"
    install -m 644 "$SCRIPT_DIR/nexus-agent.service" "$SYSTEMD_DIR/nexus-agent.service"

    systemctl --user daemon-reload || warn "systemctl daemon-reload failed (run manually)"
    systemctl --user enable nexus-agent || warn "systemctl enable failed (run manually)"

    # Install the self-deploy timer alongside the agent on Linux hosts so the
    # homelab keeps itself current with origin/main automatically.
    install_homelab_deploy

    echo ""
    info "Linux install complete. Next steps:"
    echo "  systemctl --user start nexus-agent"
    echo "  journalctl --user -u nexus-agent -f     # view logs"
}

install_macos() {
    # Swift dashboard build/install is delegated to the shared library at
    # deploy/lib/macos-swift-deploy.sh so the post-merge hook
    # (deploy/hooks.d/post-merge/04-swift-deploy) and this installer share
    # the same mechanics. See bd:nx-9ndp7.
    if $DO_BUILD; then
        local LIB_PATH="$SCRIPT_DIR/lib/macos-swift-deploy.sh"
        if [[ -f "$LIB_PATH" ]]; then
            # shellcheck source=lib/macos-swift-deploy.sh
            source "$LIB_PATH"
            if ! macos_swift_deploy_run; then
                warn "Swift dashboard build/install failed — continuing with agent install."
            fi
        else
            warn "shared lib not found at $LIB_PATH — skipping Swift dashboard build."
        fi
    fi

    # macOS runs NO nexus-agent daemon under the spine model — it is a pure
    # Swift app + Tailnet member. The dashboard reads remote agents over the
    # Tailnet.
    #
    # EXCEPTION (nx-tceo6): a GUI-session deploy LaunchAgent. The
    # post-merge/post-commit git hook runs over SSH (homelab fan-out) in a
    # NON-Aqua session where the team signing identity fails. The hook
    # kickstarts this agent so the SIGNED build runs in the user's GUI session.
    # Install it idempotently: bootout (ignore-not-loaded) then bootstrap.
    install_macos_deploy_agent

    # iOS device deploy Aqua bridge (nx-tceo6). Loads the GUI LaunchAgent so
    # deploy/ios-deploy.sh can kickstart signed iOS device installs over SSH.
    install_ios_deploy_agent

    # Always-on presence sensor (mac-presence-observer, Phase 1.5). Loads the
    # RunAtLoad+KeepAlive LaunchAgent in gui/501 so the local Mac reports
    # presence (idle/lock/camera/mic/Focus/home) to its agent continuously.
    install_presence_agent

    echo ""
    info "macOS install complete."
    if [[ -d /Applications/Nexus.app ]]; then
        echo "  open /Applications/Nexus.app                    # launch dashboard"
    fi
}

case "$PLATFORM" in
    linux)  install_linux ;;
    macos)  install_macos ;;
esac

# ── Env drift check ────────────────────────────────────────────────
# Env drift check — added 2026-05-26 to prevent recurrence of nx-dbame silent
# dropout (canonical /nexus DB silently rotated to /cortex; .env diverged from
# secrets.env.example). Compares KEY SETS (not values) and POSTGRES_URL db-name
# segments between the example template and the active ~/.env. Idempotent.
check_env_drift() {
    local example="$SCRIPT_DIR/secrets.env.example"
    local target="$HOME/.env"
    [[ -f "$example" ]] || { warn "[env-drift] missing template: $example"; return 0; }
    [[ -f "$target"  ]] || { warn "[env-drift] no $target — copy from $example to populate"; return 0; }

    local example_keys target_keys
    example_keys=$(grep -E '^[A-Z_][A-Z0-9_]*=' "$example" | cut -d= -f1 | sort -u)
    target_keys=$(grep -E '^[A-Z_][A-Z0-9_]*=' "$target" | cut -d= -f1 | sort -u)

    local missing
    missing=$(comm -23 <(printf '%s\n' "$example_keys") <(printf '%s\n' "$target_keys"))
    if [[ -n "$missing" ]]; then
        while IFS= read -r key; do
            [[ -z "$key" ]] && continue
            printf '\033[1;33m[WARN env-drift]\033[0m key missing from %s: %s — copy default from %s\n' "$target" "$key" "$example"
        done <<< "$missing"
    fi

    # DB-name drift: warn if any *POSTGRES_URL* db-segment differs (silent-failure vector).
    while IFS= read -r key; do
        [[ -z "$key" ]] && continue
        local ex_val tg_val ex_db tg_db
        ex_val=$(grep -E "^${key}=" "$example" | head -1 | cut -d= -f2-)
        tg_val=$(grep -E "^${key}=" "$target"  | head -1 | cut -d= -f2-)
        [[ -z "$tg_val" ]] && continue
        ex_db=$(printf '%s' "$ex_val" | sed -E 's|.*/([^/?]+).*|\1|')
        tg_db=$(printf '%s' "$tg_val" | sed -E 's|.*/([^/?]+).*|\1|')
        if [[ -n "$ex_db" && -n "$tg_db" && "$ex_db" != "$tg_db" ]]; then
            printf '\033[1;33m[WARN env-drift]\033[0m %s db-segment differs: example=/%s target=/%s — verify intentional\n' "$key" "$ex_db" "$tg_db"
        fi
    done < <(grep -oE '^[A-Z_]*POSTGRES_URL[A-Z_]*' "$example" | sort -u)
}
check_env_drift

# ── Install git hook dispatchers ───────────────────────────────────

if [[ -d "$REPO_DIR/.git" ]]; then
    info "Installing git hook dispatchers"
    install -m 755 "$SCRIPT_DIR/hooks/post-merge-dispatcher" "$REPO_DIR/.git/hooks/post-merge"
    install -m 755 "$SCRIPT_DIR/hooks/post-commit-dispatcher" "$REPO_DIR/.git/hooks/post-commit"
    install -m 755 "$SCRIPT_DIR/hooks/pre-push-dispatcher" "$REPO_DIR/.git/hooks/pre-push"
else
    warn "Not a git repository — skipping hook installation"
fi

echo ""
info "Config directory: $CONFIG_DIR"
