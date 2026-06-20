#!/usr/bin/env bash
# presence-endpoint.sh — derive + inject NX_PRESENCE_ENDPOINT into the
# installed presence LaunchAgent plist (nx-mn2t1).
#
# WHY THIS EXISTS
# ----------------
# The presence sensor (apps/swift/nexus-presence) reads NX_PRESENCE_ENDPOINT
# and defaults to http://localhost:7400. The Mac runs NO local nexus-agent, so
# its presence must POST to the homelab agent. But BOTH deploy paths reinstall
# the plist verbatim (`install -m 644`), wiping any manual NX_PRESENCE_ENDPOINT
# edit on every deploy:
#   1. deploy/install.sh            -> install_presence_agent()
#   2. deploy/lib/macos-swift-deploy.sh -> _macos_presence_deploy()
#
# The fix: a single shared helper (this file) that both call AFTER the
# `install -m 644` but BEFORE `launchctl bootout/bootstrap`. It DERIVES the
# endpoint from the durable, deploy-untouched source (~/.config/nexus/agents.toml)
# and re-injects it into the freshly-installed plist via PlistBuddy. Idempotent
# (Add-or-Set). Result: the endpoint survives every reinstall.
#
# DERIVATION RULE (first match wins; documented + explicit)
# ----------------------------------------------------------
#   1. Explicit override — a top-level `presence_endpoint = "http://host:port"`
#      key in agents.toml. Read via grep/sed (NOT a full TOML parse). If set,
#      use it verbatim. This is the Mac's durable source of truth.
#   2. Fallback derivation — when `presence_endpoint` is absent AND this machine
#      does NOT run a local nexus-agent (no `nexus-agent` process), point at the
#      first remote `[[agents]]` entry whose `host` is NOT this machine
#      (self_name / hostname). e.g. omarchy host=homelab.
#   3. No injection — if this machine DOES run a local nexus-agent, the default
#      (localhost:7400) is correct; leave the plist alone.
#   4. Nothing resolves — leave the plist default (localhost) and warn. NEVER
#      hard-fail the deploy.
#
# PARSER-TOLERANCE NOTE (verified 2026-06-20, nx-mn2t1)
# ------------------------------------------------------
# Adding a top-level `presence_endpoint` key to agents.toml is SAFE — both
# parsers tolerate the unknown key:
#   - TS  (packages/core/src/config.ts): NexusConfigSchema is a plain z.object
#     with NO .strict() -> Zod strips unknown top-level keys silently.
#   - Swift (NexusShared/Networking/AgentRegistry.swift): parse() only captures
#     keys INSIDE [[agents]] records; a top-level scalar before the first
#     [[agents]] is ignored by the `guard inAgent` skip.
# So agents.toml stays the single durable source; no dedicated file needed.

NX_PRESENCE_AGENTS_TOML="${NX_PRESENCE_AGENTS_TOML:-$HOME/.config/nexus/agents.toml}"
NX_PLISTBUDDY="${NX_PLISTBUDDY:-/usr/libexec/PlistBuddy}"

_nx_presence_info() { printf '\033[1;32mpresence-endpoint: %s\033[0m\n' "$1"; }
_nx_presence_warn() { printf '\033[1;33mpresence-endpoint: %s\033[0m\n' "$1" >&2; }

# Read the optional top-level `presence_endpoint` scalar from agents.toml.
# Only matches a top-level key (a line at column 0 that is NOT inside a
# [[agents]] / [section] table). grep/sed only — no TOML lib. Echoes the URL
# (no quotes) on stdout, or nothing if absent.
_nx_presence_explicit_endpoint() {
    local toml="$1"
    [[ -f "$toml" ]] || return 0
    # awk: stop scanning at the first table header so we only read top-level
    # scalars; capture presence_endpoint = "..." (tolerates whitespace).
    awk '
        /^[[:space:]]*\[/ { exit }                       # first table header ends top-level scope
        /^[[:space:]]*presence_endpoint[[:space:]]*=/ {
            line = $0
            sub(/^[^=]*=[[:space:]]*/, "", line)         # strip key + =
            sub(/[[:space:]]*#.*$/, "", line)            # strip trailing comment
            gsub(/^[[:space:]]*"?|"?[[:space:]]*$/, "", line)  # strip quotes/ws
            print line
            exit
        }
    ' "$toml"
}

# Read top-level self_name scalar (for "is this remote?" comparison).
_nx_presence_self_name() {
    local toml="$1"
    [[ -f "$toml" ]] || return 0
    awk '
        /^[[:space:]]*\[/ { exit }
        /^[[:space:]]*self_name[[:space:]]*=/ {
            line = $0
            sub(/^[^=]*=[[:space:]]*/, "", line)
            sub(/[[:space:]]*#.*$/, "", line)
            gsub(/^[[:space:]]*"?|"?[[:space:]]*$/, "", line)
            print line
            exit
        }
    ' "$toml"
}

# Derive the first remote agent endpoint (http://host:port) from [[agents]]
# whose `name` != self_name and `host` != localhost/127.0.0.1/this hostname.
# Echoes the URL or nothing.
_nx_presence_remote_endpoint() {
    local toml="$1" self="$2"
    [[ -f "$toml" ]] || return 0
    local host_short; host_short="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo '')"
    awk -v self="$self" -v hostshort="$host_short" '
        function flush() {
            if (name != "" && host != "" && port != "") {
                # skip self entry + loopback + this machine
                if (name != self && host != "localhost" && host != "127.0.0.1" \
                    && host != hostshort) {
                    print "http://" host ":" port
                    found = 1
                }
            }
            name=""; host=""; port=""
        }
        /^[[:space:]]*\[\[agents\]\]/ { if (inagent) flush(); inagent=1; next }
        /^[[:space:]]*\[/            { if (inagent) flush(); inagent=0; next }
        {
            if (!inagent || found) next
            if ($0 ~ /^[[:space:]]*name[[:space:]]*=/)  { v=$0; sub(/^[^=]*=[[:space:]]*/,"",v); gsub(/[[:space:]"]/,"",v); name=v }
            if ($0 ~ /^[[:space:]]*host[[:space:]]*=/)  { v=$0; sub(/^[^=]*=[[:space:]]*/,"",v); gsub(/[[:space:]"]/,"",v); host=v }
            if ($0 ~ /^[[:space:]]*port[[:space:]]*=/)  { v=$0; sub(/^[^=]*=[[:space:]]*/,"",v); gsub(/[[:space:]"]/,"",v); port=v }
        }
        END { if (inagent && !found) flush() }
    ' "$toml"
}

# True when a local nexus-agent daemon is running on this machine.
_nx_presence_local_agent_running() {
    pgrep -x nexus-agent >/dev/null 2>&1 && return 0
    pgrep -f 'nexus-agent' >/dev/null 2>&1 && return 0
    return 1
}

# Resolve the endpoint to inject (echoes URL on stdout, or nothing if the
# default localhost is correct / nothing resolves).
nx_resolve_presence_endpoint() {
    local toml="${1:-$NX_PRESENCE_AGENTS_TOML}"

    # 1. Explicit override always wins.
    local explicit; explicit="$(_nx_presence_explicit_endpoint "$toml")"
    if [[ -n "$explicit" ]]; then
        echo "$explicit"
        return 0
    fi

    # 3. Local agent present -> localhost default is correct; no injection.
    if _nx_presence_local_agent_running; then
        return 0
    fi

    # 2. No local agent -> derive the first remote agent endpoint.
    local self; self="$(_nx_presence_self_name "$toml")"
    local remote; remote="$(_nx_presence_remote_endpoint "$toml" "$self")"
    if [[ -n "$remote" ]]; then
        echo "$remote"
        return 0
    fi

    # 4. Nothing resolved.
    return 0
}

# Inject NX_PRESENCE_ENDPOINT into the installed plist at $1. Idempotent
# Add-or-Set via PlistBuddy. NEVER hard-fails the deploy.
#
#   nx_inject_presence_endpoint <installed-plist-path> [agents.toml-path]
nx_inject_presence_endpoint() {
    local plist="$1"
    local toml="${2:-$NX_PRESENCE_AGENTS_TOML}"

    if [[ -z "$plist" || ! -f "$plist" ]]; then
        _nx_presence_warn "plist not found at '$plist' — skipping endpoint injection"
        return 0
    fi
    if [[ ! -x "$NX_PLISTBUDDY" ]]; then
        _nx_presence_warn "PlistBuddy not found at $NX_PLISTBUDDY — skipping endpoint injection (plist keeps localhost default)"
        return 0
    fi

    local endpoint; endpoint="$(nx_resolve_presence_endpoint "$toml")"
    if [[ -z "$endpoint" ]]; then
        _nx_presence_info "no remote endpoint resolved (local agent or no agents.toml entry) — plist keeps localhost default"
        return 0
    fi

    # Add-or-Set: try Set first (key already present), else Add. The
    # EnvironmentVariables dict already exists in the shipped plist (PATH/HOME),
    # so we only need to manage the NX_PRESENCE_ENDPOINT child.
    if "$NX_PLISTBUDDY" -c "Set :EnvironmentVariables:NX_PRESENCE_ENDPOINT $endpoint" "$plist" >/dev/null 2>&1; then
        _nx_presence_info "set NX_PRESENCE_ENDPOINT=$endpoint in $plist"
    elif "$NX_PLISTBUDDY" -c "Add :EnvironmentVariables:NX_PRESENCE_ENDPOINT string $endpoint" "$plist" >/dev/null 2>&1; then
        _nx_presence_info "added NX_PRESENCE_ENDPOINT=$endpoint to $plist"
    else
        # As a last resort the EnvironmentVariables dict might be missing —
        # create it then add the key. Best-effort; never abort the deploy.
        "$NX_PLISTBUDDY" -c "Add :EnvironmentVariables dict" "$plist" >/dev/null 2>&1 || true
        if "$NX_PLISTBUDDY" -c "Add :EnvironmentVariables:NX_PRESENCE_ENDPOINT string $endpoint" "$plist" >/dev/null 2>&1; then
            _nx_presence_info "created EnvironmentVariables + added NX_PRESENCE_ENDPOINT=$endpoint in $plist"
        else
            _nx_presence_warn "could not inject NX_PRESENCE_ENDPOINT into $plist (plist keeps localhost default)"
        fi
    fi
    return 0
}
