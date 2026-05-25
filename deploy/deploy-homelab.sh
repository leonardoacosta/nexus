#!/usr/bin/env bash
set -uo pipefail

# Nexus — homelab self-deploy.
#
# Idempotent deploy intended to run ON the homelab, driven by a
# systemd --user timer (deploy/nexus-homelab-deploy.timer). It pulls
# origin/main, lets the post-merge git hooks build + migrate + restart
# the agent, then verifies the agent came back healthy and rolls back
# to the previous binary if it did not.
#
# Safety contract (see bd:nx-kizf6):
#   - No-op (exit 0) when the repo is already at origin/main — no pull,
#     no rebuild, no restart.
#   - The build runs BEFORE the running service is touched: the
#     post-merge `02-deploy` hook fails (exit 1) on a build error
#     before it overwrites the installed binary, so a broken build can
#     never corrupt the live agent.
#   - A binary backup is taken before the pull. After the restart, the
#     agent is health-checked (systemctl is-active + HTTP 200). On
#     failure the previous binary is restored and the agent restarted,
#     and the script exits non-zero. The agent is NEVER left down.
#
# This script is installed to a STABLE path (~/.local/bin/nexus-homelab-deploy)
# by `deploy/install.sh --homelab-deploy`, deliberately decoupled from the
# repo checkout so the timer can run even while the repo is mid-pull.
#
# Usage:
#   nexus-homelab-deploy            # pull-if-behind, build, restart, verify
#   NX_REPO=/path/to/nx nexus-homelab-deploy
#
# Overridable env:
#   NX_REPO      repo checkout                 (default: ~/dev/nx)
#   NX_BIN_DIR   installed binary dir          (default: ~/.local/bin)
#   NX_AGENT_URL agent base URL for health     (default: http://127.0.0.1:7400)
#   NX_SERVICE   systemd --user unit name      (default: nexus-agent)

REPO_DIR="${NX_REPO:-$HOME/dev/nx}"
BIN_DIR="${NX_BIN_DIR:-$HOME/.local/bin}"
AGENT_URL="${NX_AGENT_URL:-http://127.0.0.1:7400}"
SERVICE="${NX_SERVICE:-nexus-agent}"
AGENT_BIN="$BIN_DIR/nexus-agent"
BACKUP_BIN="$BIN_DIR/nexus-agent.deploy-backup"

# ── Structured logging (timestamped — journal-friendly) ─────────────

log()  { printf '%s deploy-homelab: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }
err()  { printf '%s deploy-homelab: ERROR %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >&2; }

# ── Health check: agent is active AND answering HTTP ────────────────

agent_healthy() {
    systemctl --user is-active --quiet "$SERVICE" || return 1
    # /sessions is a cheap GET that exercises the DB + route table.
    # Retry briefly to absorb the post-restart bind + Tailscale-IP probe.
    local code attempt
    for attempt in 1 2 3 4 5 6; do
        code="$(curl -fsS -o /dev/null -w '%{http_code}' \
            --max-time 5 "$AGENT_URL/sessions" 2>/dev/null || true)"
        if [[ "$code" == "200" ]]; then
            return 0
        fi
        log "health attempt ${attempt}/6: HTTP '${code:-no-response}', retrying in 2s"
        sleep 2
    done
    return 1
}

# ── Preflight ──────────────────────────────────────────────────────

if [[ ! -d "$REPO_DIR/.git" ]]; then
    err "repo not found at $REPO_DIR (set NX_REPO to override)"
    exit 1
fi
cd "$REPO_DIR"

if ! command -v git &>/dev/null; then
    err "git not on PATH"
    exit 1
fi

# ── Determine if we are behind origin/main ─────────────────────────

log "checking $REPO_DIR against origin/main"

if ! git fetch --quiet origin main 2>/dev/null; then
    err "git fetch origin main failed (network?) — leaving agent untouched"
    exit 1
fi

BEFORE="$(git rev-parse HEAD)"
TARGET="$(git rev-parse origin/main)"

if [[ "$BEFORE" == "$TARGET" ]]; then
    log "already up to date at ${BEFORE:0:8} — no-op"
    exit 0
fi

log "behind origin/main: ${BEFORE:0:8} -> ${TARGET:0:8}"

# ── Refuse to pull over local edits (would break --ff-only / hooks) ─

if [[ -n "$(git status --porcelain)" ]]; then
    err "working tree is dirty — refusing to pull. Resolve manually:"
    git status --porcelain >&2
    exit 1
fi

# ── Back up the current binary so we can roll back on failure ──────

if [[ -f "$AGENT_BIN" ]]; then
    if cp -p "$AGENT_BIN" "$BACKUP_BIN"; then
        log "backed up current agent binary -> $BACKUP_BIN"
    else
        err "could not back up $AGENT_BIN — refusing to proceed (no rollback safety net)"
        exit 1
    fi
else
    log "no existing agent binary at $AGENT_BIN (first deploy?) — proceeding without rollback snapshot"
fi

# ── Pull. The post-merge hook chain (02-deploy + 03-migrate) fires ──
#    here: it bun-installs if deps changed, builds (fail-fast BEFORE
#    overwriting the binary), installs, and restarts the agent.

log "git pull --ff-only origin main (fires post-merge build/migrate/restart hooks)"

if ! git pull --ff-only origin main; then
    err "git pull --ff-only failed — agent untouched, still at ${BEFORE:0:8}"
    exit 1
fi

AFTER="$(git rev-parse HEAD)"

if [[ "$AFTER" != "$TARGET" ]]; then
    err "post-pull HEAD ${AFTER:0:8} != target ${TARGET:0:8} — unexpected; investigate"
    # The post-merge hooks may still have restarted the agent; verify below.
fi

log "repo now at ${AFTER:0:8}"

# ── Defensive build + restart ──────────────────────────────────────
#    The post-merge `02-deploy` hook normally builds + installs +
#    restarts on its own. If the hook is missing or skipped (e.g.
#    no apps/agent/ change detected but binary missing), guarantee the
#    binary is present and the service is up. This is build-then-restart
#    safe: a failed build aborts BEFORE we install or restart.

if [[ ! -x "$AGENT_BIN" ]]; then
    log "agent binary missing after pull — building defensively"
    if command -v bun &>/dev/null; then
        if (cd "$REPO_DIR/apps/agent" && bun run build); then
            install -m 755 "$REPO_DIR/apps/agent/nexus-agent" "$AGENT_BIN"
            log "defensive build installed -> $AGENT_BIN"
            systemctl --user restart "$SERVICE" || err "defensive restart failed"
        else
            err "defensive build failed and no binary present — agent may be down"
        fi
    else
        err "bun not on PATH and no agent binary present"
    fi
fi

# ── Health-check the (re)started agent; roll back on failure ───────

log "verifying agent health (systemctl is-active + HTTP $AGENT_URL/sessions)"

if agent_healthy; then
    log "agent healthy at ${AFTER:0:8} — deploy complete"
    rm -f "$BACKUP_BIN"
    exit 0
fi

# ── Rollback path ──────────────────────────────────────────────────

err "agent did NOT come back healthy after deploy to ${AFTER:0:8}"

if [[ -f "$BACKUP_BIN" ]]; then
    err "rolling back to previous binary ($BACKUP_BIN)"
    if install -m 755 "$BACKUP_BIN" "$AGENT_BIN"; then
        systemctl --user restart "$SERVICE" || err "rollback restart command failed"
        if agent_healthy; then
            err "ROLLBACK SUCCEEDED — agent restored to previous binary (repo left at ${AFTER:0:8}; investigate the new build)"
            rm -f "$BACKUP_BIN"
            exit 1
        fi
        err "ROLLBACK restart did not restore health — agent may be DOWN. Manual intervention required."
        err "journalctl --user -u $SERVICE -n 80"
        exit 1
    fi
    err "could not reinstall backup binary — agent may be DOWN. Manual intervention required."
    exit 1
fi

err "no backup binary to roll back to — attempting a plain restart of $SERVICE"
systemctl --user restart "$SERVICE" || true
if agent_healthy; then
    err "plain restart restored health, but on the NEW (possibly broken) binary — investigate."
    exit 1
fi
err "agent is DOWN and could not be recovered automatically. journalctl --user -u $SERVICE -n 80"
exit 1
