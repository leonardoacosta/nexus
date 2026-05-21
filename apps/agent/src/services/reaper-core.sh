#!/usr/bin/env bash
# Weekly cache reaper — vendored verbatim from
# `~/dev/if/home/dot_local/bin/executable_weekly-cleanup` (if@8c49609) and
# adapted for in-process invocation by `reaper-job.ts`.
#
# This is the DESTRUCTIVE CORE — every safety invariant from the chezmoi
# original is preserved verbatim. The TS wrapper owns only orchestration
# (spawn, parse, persist, notify); the destructive guards live here.
#
# Triggered by nexus-agent's CronService (weekly, Sunday 03:00 local).
# Run manually: bash apps/agent/src/services/reaper-core.sh [--dry-run]
# Live output:  tail -f ~/.local/state/weekly-cleanup.log
#
# Destructive-safety invariants (DO NOT WEAKEN):
#   - `set -u` only (NO `set -e` / `pipefail`) — a best-effort reaper must
#     not abort on the first non-zero step. Every step is `|| true`-guarded.
#   - `_on_exit` silent-abort trap emits a loud failure on any early exit.
#   - Completion sentinel (`COMPLETED=1`) + success heartbeat under
#     ~/.local/state/weekly-cleanup.last-success.
#   - `node_modules` and `.git` under `~/dev` are NEVER touched.
#   - `.turbo`/`.next`/`*.bun-build` sweeps are age-gated to >7 days.
#   - Active logs are TRUNCATED (inode/fd preserved), never deleted.
#   - Stray `$HOME/*.Default.w*.log` files >7d are deleted, not truncated.
#   - bloat_radar() is informational ONLY — never deletes.
#
# Machine-parseable result lines (consumed by reaper-job.ts):
#   - "NEXUS_RESULT key=value ..." emitted on stdout after each phase
#   - "NEXUS_BLOAT label=<l>|path=<p>|size_bytes=<sz>|threshold_bytes=<th>"
#     emitted by bloat_radar for each finding (zero rows on clear run)
#
# NOTE: deliberately NOT `set -e` / `set -o pipefail`. See header.
set -u

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

LOG_FILE="$HOME/.local/state/weekly-cleanup.log"
HEARTBEAT="$HOME/.local/state/weekly-cleanup.last-success"
mkdir -p "$(dirname "$LOG_FILE")"
# Plain append — NOT `> >(tee …)`. Process substitution drops buffered
# output when launchd reaps the process group on early exit. `tail -f`
# the log for live output on manual runs.
#
# When wrapped by `reaper-job.ts` the parent owns the tee — it streams
# stdout to BOTH its pipe (for NEXUS_RESULT / NEXUS_BLOAT parsing) AND
# `$LOG_FILE`. Set NEXUS_REAPER_NO_REDIRECT=1 in that case so the script
# does NOT capture its own stdout into the log file; the wrapper does.
if [[ "${NEXUS_REAPER_NO_REDIRECT:-0}" != "1" ]]; then
  exec >> "$LOG_FILE" 2>&1
fi

# ── Machine-parseable result emitter ──────────────────────────────────
# Emits "NEXUS_RESULT key=value ..." lines to stdout in a structured form
# the TS wrapper parses, without regressing the human-readable log lines.
# Each `result_line` call appends one line.
result_line() {
  echo "NEXUS_RESULT $*"
}

# Same line format for per-finding bloat rows. Pipe-delimited fields so a
# free-text label can carry spaces without breaking the parser.
bloat_line() {
  local label="$1" path="$2" size_bytes="$3" threshold_bytes="$4"
  echo "NEXUS_BLOAT label=${label}|path=${path}|size_bytes=${size_bytes}|threshold_bytes=${threshold_bytes}"
}

# ── Helpers (verbatim port) ───────────────────────────────────────────

# Format human-readable size from KB. Mirrors `du -h` thresholds so the
# banner reads consistently with the script's per-line output.
human_kb() {
  local kb="$1"
  if   (( kb >= 1048576 )); then printf '%.1fG' "$(bc -l <<<"$kb/1048576")"
  elif (( kb >= 1024    )); then printf '%.0fM' "$(bc -l <<<"$kb/1024")"
  else                            printf '%dK' "$kb"
  fi
}

# Quick `du -sk` wrapper that returns 0 if the path doesn't exist.
size_kb() {
  [[ -d "$1" ]] || { echo 0; return; }
  du -sk "$1" 2>/dev/null | awk '{print $1}'
}

# ── Bloat radar ───────────────────────────────────────────────────────
# Early-warning for adjacent dirs the reaper deliberately does NOT auto-
# delete (judgment-required) but that silently balloon.
BLOAT_WARN=""
bloat_check() {   # label  path  threshold_gb  hint
  local label="$1" path="$2" thr_gb="$3" hint="$4" kb thr_kb
  [[ -e "$path" ]] || return
  kb=$(du -sk "$path" 2>/dev/null | awk '{print $1}')
  [[ -z "$kb" ]] && return
  thr_kb=$(( thr_gb * 1048576 ))
  if (( kb > thr_kb )); then
    echo "  BLOAT  $label  $(human_kb "$kb") (> ${thr_gb}G) — $hint"
    BLOAT_WARN+="${BLOAT_WARN:+; }$label $(human_kb "$kb")"
    # Machine-parseable. Bytes = KB * 1024.
    bloat_line "$label" "$path" "$(( kb * 1024 ))" "$(( thr_kb * 1024 ))"
  fi
}

bloat_radar() {
  echo "  -- bloat radar (adjacent dirs NOT auto-cleaned) --"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    bloat_check "Xcode/Developer"   "/Library/Developer"                                  50 "xcrun simctl runtime delete <old>"
    bloat_check "CoreSimulator"     "$HOME/Library/Developer/CoreSimulator"               20 "delete unused sim devices"
    bloat_check "iOS DeviceSupport" "$HOME/Library/Developer/Xcode/iOS DeviceSupport"      5 "rm stale device-support dirs"
    bloat_check "Claude vm_bundles" "$HOME/Library/Application Support/Claude/vm_bundles"   3 "rm if not using Claude local-VM"
    bloat_check "colima"            "$HOME/.config/colima"                                  3 "colima delete if unused"
    # Runaway Chrome profile History — the exact failure this all chased.
    local h prof khb thr_kb_chrome
    thr_kb_chrome=307200   # 300 MB
    for h in "$HOME/Library/Application Support/Google/Chrome/"*/History; do
      [[ -f "$h" ]] || continue
      khb=$(du -sk "$h" 2>/dev/null | awk '{print $1}')
      [[ -z "$khb" ]] && continue
      if (( khb > thr_kb_chrome )); then
        prof=$(basename "$(dirname "$h")")
        echo "  BLOAT  Chrome '$prof' History  $(human_kb "$khb") (>300M) — runaway history, inspect/purge"
        BLOAT_WARN+="${BLOAT_WARN:+; }Chrome '$prof' History $(human_kb "$khb")"
        bloat_line "Chrome '$prof' History" "$h" "$(( khb * 1024 ))" "$(( thr_kb_chrome * 1024 ))"
      fi
    done
  fi
  bloat_check ".nuget"     "$HOME/.nuget"        8 "nuget locals clear failing?"
  bloat_check "pnpm store" "$HOME/Library/pnpm" 12 "pnpm store prune ineffective?"
  # Oversized ~/dev repos (informational — node_modules-inclusive).
  if [[ -d "$HOME/dev" ]]; then
    local szk path thr_kb_dev
    thr_kb_dev=8388608  # 8 GB
    while IFS=$'\t' read -r szk path; do
      [[ -z "$szk" ]] && continue
      if (( szk > thr_kb_dev )); then
        echo "  BLOAT  dev/$(basename "$path")  $(human_kb "$szk") (>8G) — stale clone / build output?"
        BLOAT_WARN+="${BLOAT_WARN:+; }dev/$(basename "$path") $(human_kb "$szk")"
        bloat_line "dev/$(basename "$path")" "$path" "$(( szk * 1024 ))" "$(( thr_kb_dev * 1024 ))"
      fi
    done < <(du -sk "$HOME"/dev/*/ 2>/dev/null)
  fi
  [[ -z "$BLOAT_WARN" ]] && echo "  (clear — nothing over threshold)"
}

# ── Silent-abort guard ────────────────────────────────────────────────
# Any exit that didn't reach the completion sentinel emits a failure
# result line the TS wrapper sees as `status="aborted"`.
COMPLETED=0
_on_exit() {
  local rc=$?
  (( COMPLETED == 1 )) && return
  echo "=== ABORTED rc=$rc — did not reach completion sentinel ==="
  result_line "status=aborted rc=$rc log_path=$LOG_FILE"
}
trap _on_exit EXIT

# ── Phase 1: snapshot bloat BEFORE cleanup ────────────────────────────
echo
echo "=== weekly-cleanup $(date -Iseconds) (dry_run=$DRY_RUN) ==="
result_line "started_at=$(date -Iseconds) dry_run=$DRY_RUN log_path=$LOG_FILE"

START_FREE_KB=$(df -k "$HOME" | tail -1 | awk '{print $4}')
START_FREE_PCT=$(df -k "$HOME" | tail -1 | awk '{print $5}')

XDG_KB=$(size_kb "$HOME/.cache")
LIB_CACHES_KB=$(size_kb "$HOME/Library/Caches")
NPM_KB=$(size_kb "$HOME/.npm")
BUN_KB=$(size_kb "$HOME/.bun/install/cache")
CARGO_KB=$(size_kb "$HOME/.cargo/registry/cache")

# Total reclaimable on this OS
RECLAIMABLE_KB=$((XDG_KB + NPM_KB + BUN_KB))
[[ "$(uname -s)" == "Darwin" ]] && RECLAIMABLE_KB=$((RECLAIMABLE_KB + LIB_CACHES_KB))
[[ "$(uname -s)" == "Linux"  ]] && RECLAIMABLE_KB=$((RECLAIMABLE_KB + CARGO_KB))

echo "  free at start:     $(human_kb "$START_FREE_KB") ($START_FREE_PCT used)"
echo "  xdg-cache:         $(human_kb "$XDG_KB")"
[[ "$(uname -s)" == "Darwin" ]] && echo "  library-caches:    $(human_kb "$LIB_CACHES_KB")"
echo "  npm cache:         $(human_kb "$NPM_KB")"
echo "  bun cache:         $(human_kb "$BUN_KB")"
[[ "$(uname -s)" == "Linux"  ]] && echo "  cargo cache:       $(human_kb "$CARGO_KB")"
echo "  reclaimable est:   $(human_kb "$RECLAIMABLE_KB")"

# Prior-run health check — informational; the TS wrapper queries the
# `cron_runs` table for the canonical stale-heartbeat detector.
PRIOR_WARN=""
if [[ ! -f "$HEARTBEAT" ]]; then
  PRIOR_WARN="[NO PRIOR SUCCESS] "
elif [[ -n "$(find "$HEARTBEAT" -mtime +8 2>/dev/null)" ]]; then
  PRIOR_WARN="[LAST SUCCESS >8d AGO] "
fi
[[ -n "$PRIOR_WARN" ]] && echo "  WARN: ${PRIOR_WARN}reaper may have been failing silently"

# ── Phase 2: clean ────────────────────────────────────────────────────
PRUNED_COUNT=0
clean_dir() {
  local label="$1" path="$2"
  if [[ ! -d "$path" ]]; then
    printf '  skip  %-18s (not present)\n' "$label"
    return
  fi
  local size
  size=$(du -sh "$path" 2>/dev/null | awk '{print $1}')
  if (( DRY_RUN )); then
    printf '  DRY   %-18s would clean %s (%s)\n' "$label" "$path" "$size"
  else
    printf '  clean %-18s %s (%s)\n' "$label" "$path" "$size"
    find "$path" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
    PRUNED_COUNT=$((PRUNED_COUNT + 1))
  fi
}

run_cmd() {
  local label="$1"; shift
  if (( DRY_RUN )); then
    printf '  DRY   %-18s would run: %s\n' "$label" "$*"
  else
    printf '  run   %-18s %s\n' "$label" "$*"
    if ! "$@" >/dev/null 2>&1; then
      printf '    warn: %s exited non-zero\n' "$label"
    else
      PRUNED_COUNT=$((PRUNED_COUNT + 1))
    fi
  fi
}

# Truncate (not delete) runaway *.log files over a size threshold in a
# safelist of log dirs. Truncation preserves the inode/fd so a running
# writer (e.g. a gateway daemon) keeps logging.
TRUNCATED_COUNT=0
truncate_logs() {
  local threshold_mb=200 d f sz
  for d in "$HOME/.local/state" "$HOME/.openclaw/logs" "$HOME/Library/Logs"; do
    [[ -d "$d" ]] || continue
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      sz=$(du -h "$f" 2>/dev/null | awk '{print $1}')
      if (( DRY_RUN )); then
        printf '  DRY   %-18s would truncate %s (%s)\n' "log-truncate" "$f" "$sz"
      else
        printf '  trunc %-18s %s (%s)\n' "log-truncate" "$f" "$sz"
        : > "$f" 2>/dev/null || true
        TRUNCATED_COUNT=$((TRUNCATED_COUNT + 1))
      fi
    done < <(find "$d" -type f -name '*.log' -size "+${threshold_mb}M" 2>/dev/null)
  done
}

# Sweep regenerable BUILD output under ~/dev — .turbo / .next dirs and
# *.bun-build files — untouched for >7 days. NEVER touches node_modules
# or .git.
BUILD_SWEEP_COUNT=0
sweep_build_caches() {
  [[ -d "$HOME/dev" ]] || return
  local age_days=7 target
  while IFS= read -r target; do
    [[ -z "$target" ]] && continue
    if (( DRY_RUN )); then
      printf '  DRY   %-18s would rm %s\n' "build-cache" "$target"
    else
      rm -rf "$target" 2>/dev/null || true
    fi
    BUILD_SWEEP_COUNT=$((BUILD_SWEEP_COUNT + 1))
  done < <(
    find "$HOME/dev" \
      \( -type d -name node_modules -prune \) -o \
      \( -type d -name .git -prune \) -o \
      \( -type d \( -name .turbo -o -name .next \) -mtime "+${age_days}" -prune -print \) -o \
      \( -type f -name '.*.bun-build' -mtime "+${age_days}" -print \) \
      2>/dev/null
  )
  printf '  sweep %-18s %d stale build-cache target(s) (>%dd, dry=%d)\n' \
    "build-cache" "$BUILD_SWEEP_COUNT" "$age_days" "$DRY_RUN"
}

# Cursor/Electron renderer crash logs get dumped straight into $HOME.
# Age-gated >7d so a fresh crash log under investigation stays.
STRAY_LOG_COUNT=0
sweep_stray_home_logs() {
  local age_days=7 f
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if (( DRY_RUN )); then
      printf '  DRY   %-18s would rm %s\n' "home-stray-log" "$(basename "$f")"
    else
      rm -f "$f" 2>/dev/null || true
    fi
    STRAY_LOG_COUNT=$((STRAY_LOG_COUNT + 1))
  done < <(find "$HOME" -maxdepth 1 -type f -name '*.Default.w*.log' -mtime "+${age_days}" 2>/dev/null)
  printf '  sweep %-18s %d stray home-root log(s) (>%dd, dry=%d)\n' \
    "home-stray-log" "$STRAY_LOG_COUNT" "$age_days" "$DRY_RUN"
}

clean_dir "xdg-cache" "$HOME/.cache"
command -v npm    >/dev/null && run_cmd "npm-cache"   npm cache clean --force
command -v pnpm   >/dev/null && run_cmd "pnpm-prune"  pnpm store prune
command -v bun    >/dev/null && run_cmd "bun-cache"   bun pm cache rm
command -v dotnet >/dev/null && run_cmd "nuget-clear" dotnet nuget locals all --clear

# Cross-platform: runaway logs + stale ~/dev build output + stray $HOME logs.
truncate_logs
sweep_build_caches
sweep_stray_home_logs

if [[ "$(uname -s)" == "Darwin" ]]; then
  clean_dir "library-caches" "$HOME/Library/Caches"
  command -v brew >/dev/null && run_cmd "brew-cleanup" brew cleanup --prune=all
fi

if [[ "$(uname -s)" == "Linux" ]]; then
  command -v yarn  >/dev/null && run_cmd "yarn-clean"  yarn cache clean
  command -v cargo >/dev/null && [[ -d "$HOME/.cargo/registry/cache" ]] && \
    clean_dir "cargo-registry" "$HOME/.cargo/registry/cache"
fi

# ── Phase 3: report ──────────────────────────────────────────────────
END_FREE_KB=$(df -k "$HOME" | tail -1 | awk '{print $4}')
END_FREE_PCT=$(df -k "$HOME" | tail -1 | awk '{print $5}')
DELTA_KB=$((END_FREE_KB - START_FREE_KB))
# Freed bytes — clamped to non-negative. Disk churn from concurrent writes
# can produce a negative delta; the wrapper treats the absolute value as
# the "freed" magnitude for reporting purposes.
FREED_KB=$DELTA_KB
(( FREED_KB < 0 )) && FREED_KB=0
FREED_BYTES=$(( FREED_KB * 1024 ))

DELTA_HUMAN=$(human_kb "$DELTA_KB")
SIGN="+"; (( DELTA_KB < 0 )) && SIGN="-" && DELTA_HUMAN=$(human_kb $((-DELTA_KB)))

echo "  free at end:       $(human_kb "$END_FREE_KB") ($END_FREE_PCT used)"
echo "=== done. delta: ${SIGN}${DELTA_HUMAN} ==="

# Completion sentinel — flips the _on_exit trap from "FAILED" to silent and
# records a success heartbeat. Set BEFORE the radar so a slow `du` in
# bloat_radar can never trip the failure trap or lose the success record.
COMPLETED=1
date -Iseconds > "$HEARTBEAT" 2>/dev/null || true

# Scan adjacent-but-untouched dirs and emit NEXUS_BLOAT lines.
bloat_radar

TOTAL_PRUNED=$(( PRUNED_COUNT + TRUNCATED_COUNT + BUILD_SWEEP_COUNT + STRAY_LOG_COUNT ))

# Final structured result line — the TS wrapper sees this AFTER all
# NEXUS_BLOAT lines so it can build the bloatFindings[] array first then
# attach the summary counters.
result_line "status=success pruned=$TOTAL_PRUNED freed_bytes=$FREED_BYTES log_path=$LOG_FILE"
