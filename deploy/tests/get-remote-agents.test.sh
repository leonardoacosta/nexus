#!/usr/bin/env bash
#
# Self-test for get_remote_agents() in
# deploy/hooks.d/post-merge/02-deploy (bd:nx-ybcs3).
#
# Proves the per-remote repo_dir contract:
#   - a [[agents]] block WITH `repo_dir` -> that path is emitted
#   - a [[agents]] block WITHOUT `repo_dir` -> defaults to ~/dev/nx
#   - self_name / localhost / 127.0.0.1 blocks are excluded from fan-out
#   - output is tab-delimited "user@host<TAB>repo_dir"
#
# The function reads $HOME/.config/nexus/agents.toml, so each case points
# HOME at an isolated temp dir seeded with a hand-written config. The
# function body is extracted from the script (not sourced whole — sourcing
# would run the real deploy) and eval'd into this shell.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../hooks.d/post-merge/02-deploy"

fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -f "$SCRIPT" ]] || fail "deploy script not found at $SCRIPT"

# Extract just the get_remote_agents() function and load it.
FN_SRC="$(sed -n '/^get_remote_agents() {/,/^}/p' "$SCRIPT")"
[[ -n "$FN_SRC" ]] || fail "could not extract get_remote_agents() from $SCRIPT"
eval "$FN_SRC"

WORK="$(mktemp -d -t nx-get-remote-agents.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

HOME="$WORK"
mkdir -p "$HOME/.config/nexus"
cat > "$HOME/.config/nexus/agents.toml" <<'EOF'
self_name = "omarchy"

[[agents]]
name = "omarchy"
host = "localhost"
port = 7400
user = "nyaptor"

[[agents]]
name = "macbook"
host = "macbook-pro"
port = 7400
user = "leonardoacosta"

[[agents]]
name = "homelab"
host = "homelab"
port = 7400
user = "nyaptor"
repo_dir = "/home/nyaptor/dev/personal/nexus"
EOF

OUT="$(get_remote_agents)"
echo "── raw output ──────────────────────────────────────"
printf '%s\n' "$OUT" | cat -A
echo "────────────────────────────────────────────────────"

# self (omarchy) is excluded even though its host is localhost — both filters apply.
# macbook has no repo_dir -> default; homelab has repo_dir -> explicit path.
EXPECTED="$(printf 'leonardoacosta@macbook-pro\t~/dev/nx\nnyaptor@homelab\t/home/nyaptor/dev/personal/nexus')"

[[ "$OUT" == "$EXPECTED" ]] || fail "output mismatch.
got:
$OUT
want:
$EXPECTED"

# Explicit per-field assertions on the tab split.
mac_line="$(printf '%s\n' "$OUT" | sed -n '1p')"
hl_line="$(printf '%s\n' "$OUT" | sed -n '2p')"

IFS=$'\t' read -r mac_target mac_repo <<< "$mac_line"
IFS=$'\t' read -r hl_target hl_repo <<< "$hl_line"

[[ "$mac_target" == "leonardoacosta@macbook-pro" ]] || fail "mac target wrong: '$mac_target'"
[[ "$mac_repo"   == "~/dev/nx" ]]                    || fail "mac repo_dir should default to ~/dev/nx, got '$mac_repo'"
[[ "$hl_target"  == "nyaptor@homelab" ]]             || fail "homelab target wrong: '$hl_target'"
[[ "$hl_repo"    == "/home/nyaptor/dev/personal/nexus" ]] || fail "homelab repo_dir should be explicit path, got '$hl_repo'"

# Absent-config case: no agents.toml -> empty output, no error.
HOME="$WORK/empty"; mkdir -p "$HOME"
[[ -z "$(get_remote_agents)" ]] || fail "missing agents.toml should produce no output"

echo "ok: default repo_dir=~/dev/nx (macbook), explicit repo_dir (homelab), self+localhost excluded, missing-config safe"
echo "PASS: get_remote_agents repo_dir contract"
