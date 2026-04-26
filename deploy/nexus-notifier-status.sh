#!/usr/bin/env bash
# nexus-notifier-status.sh — diagnostic helper for the TTS playback queue.
#
# Reports:
#   • drain-worker PID(s) (matching `nexus-notifier.sh drain`)
#   • listener PID(s)     (matching `nexus-notifier.sh listen`)
#   • FIFO queue depth (best-effort via lsof or stat)
#   • last 5 lines of both notifier log files
#
# Why a separate script: the FIFO is non-readable while a consumer holds it
# open (the read drains bytes), so `cat $FIFO` would either block or steal
# items from the player. This helper observes without consuming.
#
# Spec: openspec/changes/add-tts-playback-queue/

set -uo pipefail

FIFO="${NEXUS_NOTIFIER_FIFO:-$HOME/Library/Application Support/nexus/tts-queue.fifo}"
LISTEN_LOG="${NEXUS_NOTIFIER_LOG:-$HOME/Library/Logs/nexus-notifier.log}"
DRAIN_LOG="${NEXUS_TTS_PLAYER_LOG:-$HOME/Library/Logs/nexus-tts-player.log}"

echo "==> nexus-notifier status"
echo

# ── Process table ──────────────────────────────────────────────────────────
echo "-- processes"
listen_pid=$(/usr/bin/pgrep -f 'nexus-notifier.sh listen' 2>/dev/null || true)
drain_pid=$(/usr/bin/pgrep -f 'nexus-notifier.sh drain' 2>/dev/null || true)
echo "listener PID(s): ${listen_pid:-<none>}"
echo "drain worker PID(s): ${drain_pid:-<none>}"
echo

# ── FIFO state ─────────────────────────────────────────────────────────────
echo "-- queue"
if [ -p "$FIFO" ]; then
  echo "FIFO: $FIFO (mode: $(stat -f '%Sp' "$FIFO" 2>/dev/null || echo unknown))"
  if [ -x /usr/sbin/lsof ]; then
    # lsof on a FIFO lists every open fd — both producers and consumers.
    # Subtracting 1 for the consumer would be more meaningful but inconsistent
    # if the consumer is down, so report the raw count.
    open_fds=$(/usr/sbin/lsof "$FIFO" 2>/dev/null | /usr/bin/tail -n +2 | /usr/bin/wc -l | /usr/bin/tr -d ' ')
    echo "open fds on FIFO: ${open_fds:-0}"
  else
    echo "lsof not available — skipping queue depth probe"
  fi
else
  echo "FIFO: $FIFO (does not exist or is not a FIFO)"
fi
echo

# ── Recent logs ────────────────────────────────────────────────────────────
echo "-- recent listener log ($LISTEN_LOG)"
if [ -f "$LISTEN_LOG" ]; then
  /usr/bin/tail -n 5 "$LISTEN_LOG"
else
  echo "<missing>"
fi
echo

echo "-- recent drain log ($DRAIN_LOG)"
if [ -f "$DRAIN_LOG" ]; then
  /usr/bin/tail -n 5 "$DRAIN_LOG"
else
  echo "<missing>"
fi
