#!/usr/bin/env bash
#
# tui-surrogate.sh — a deterministic stand-in for the Claude TUI, used by the
# Tier 2 real-tmux round-trip integration tests
# (apps/agent/src/terminal/tmux-pty-source.integration.test.ts).
#
# Why a surrogate: the four PTY bugs this spec guards against (geometry
# mismatch, auto-Enter on plain input, window-size/fullscreen) are real
# tmux-interaction bugs. Testing them against the real Claude TUI would be
# non-deterministic (network, model output, timers). This script reproduces the
# exact tmux surface the bugs live in while keeping output FULLY deterministic:
#
#   - No timers, no clocks, no randomness, no background jobs.
#   - One known marker line on start (scrollback-seed assertion target).
#   - A submission counter that only increments on carriage return / newline
#     (the auto-Enter regression guard: plain chars must NOT submit).
#   - The counter is reprinted as the exact string `SUBMITS=<n>` so the test can
#     assert byte-exact via `tmux capture-pane -p`.
#
# Contract assumed by the test:
#   line 1  -> NEXUS_SURROGATE_READY   (marker, byte-exact)
#   line 2  -> SUBMITS=<n>             (n starts at 0, +1 per CR/LF received)
#   line 3  -> LAST=<char>             (last non-submit char echoed; observable
#                                       proof a plain char arrived without submit)
#
# Layout is positioned with `tput cup` so each field is reprinted in place; the
# test reads the final snapshot, so absolute positions matter less than the
# `SUBMITS=N` substring being present and unambiguous.

set -u

submits=0
last_char=""

render() {
  # Home + clear keeps the snapshot free of stale digits when the counter
  # grows in width (e.g. 9 -> 10). Deterministic: same state -> same frame.
  tput clear 2>/dev/null || printf '\033[2J\033[H'
  tput cup 0 0 2>/dev/null || printf '\033[1;1H'
  printf 'NEXUS_SURROGATE_READY\n'
  tput cup 1 0 2>/dev/null || printf '\033[2;1H'
  printf 'SUBMITS=%d\n' "$submits"
  tput cup 2 0 2>/dev/null || printf '\033[3;1H'
  printf 'LAST=%s\n' "$last_char"
}

# Initial frame so the marker + SUBMITS=0 are in scrollback before any input.
render

# Read stdin one byte at a time. `IFS=` preserves whitespace; `-r` disables
# backslash escaping; `-s` suppresses terminal echo (we render explicitly);
# `-n1` reads a single character. A bare carriage return arrives as an EMPTY
# read result (read strips the line delimiter), so the empty-string case is the
# submit trigger; any other single character is a non-submit keystroke.
while IFS= read -rsn1 ch; do
  if [ -z "$ch" ]; then
    # Carriage return / newline -> a submission.
    submits=$((submits + 1))
  else
    # Plain character: echo it, do NOT submit.
    last_char="$ch"
  fi
  render
done
