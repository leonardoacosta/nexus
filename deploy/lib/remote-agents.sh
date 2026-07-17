# Shared agents.toml remote-target parser.
#
# Extracted from deploy/hooks.d/post-merge/02-deploy (nexus-self-healing-infra,
# nx-eff6w) so the deploy-staleness cron job and the deploy hook's fan-out
# loop reuse ONE implementation instead of two copies drifting apart.
#
# Sourced, not executed — source-guard idiom (rules/TOOLING.md § Shell Script
# Strict Mode) so a bare `set -e`/`set -u` never leaks into the caller's
# shell.
(return 0 2>/dev/null) || set -euo pipefail

# Parse agents.toml for remote deploy targets.
# Returns tab-delimited lines "user@host<TAB>repo_dir" for agents that are NOT
# self_name or localhost. repo_dir is the per-remote checkout path to deploy
# from; when a block omits the optional `repo_dir` key it defaults to ~/dev/nx
# for backward compat (existing installs like the Mac need zero config change).
# A single hardcoded path can't be correct for every remote — the homelab's
# real checkout moved to ~/dev/personal/nexus during a repo reorg (nx-ybcs3).
#
# Arg 1 (optional): path to agents.toml. Defaults to the standard
# ~/.config/nexus/agents.toml location — the override exists so callers
# (e.g. tests, or a future non-standard invocation) aren't hardcoded to $HOME.
get_remote_agents() {
    local config="${1:-$HOME/.config/nexus/agents.toml}"
    [[ ! -f "$config" ]] && return

    local self_name
    self_name=$(grep '^self_name' "$config" | sed 's/.*= *"//;s/".*//')

    # Parse [[agents]] blocks — extract name, host, user, repo_dir
    awk -v self="$self_name" '
        function emit() {
            if (name != "" && name != self && host != "localhost" && host != "127.0.0.1") {
                print user "@" host "\t" (repo_dir != "" ? repo_dir : "~/dev/nx")
            }
        }
        /^\[\[agents\]\]/ { name=""; host=""; user=""; repo_dir="" }
        /^name/     { gsub(/.*= *"|"/, "", $0); name=$0 }
        /^host/     { gsub(/.*= *"|"/, "", $0); host=$0 }
        /^user/     { gsub(/.*= *"|"/, "", $0); user=$0 }
        /^repo_dir/ { gsub(/.*= *"|"/, "", $0); repo_dir=$0 }
        /^$/ || /^\[/ { emit() }
        END { emit() }
    ' "$config"
}
