#!/usr/bin/env bash
# nexus-notifier.sh — Mac-side listener for nexus NotificationFired events.
#
# Two modes (positional arg 1):
#   listen  (default) — subscribe to the SSE stream, dispatch banners, and
#                       enqueue TTS bodies onto the FIFO. Producer side.
#   drain             — read lines from the FIFO and play each via /usr/bin/say.
#                       Consumer side. Wraps each `say` in `timeout 60` so a
#                       stuck utterance can never block the queue forever.
#
# Why the split: a single fire-and-forget `say "$body" &` (the previous
# behavior) produced N concurrent `say` processes for N notifications,
# garbling audio. Splitting producer/consumer through a FIFO serializes
# playback while keeping the SSE listener responsive — the producer write
# is non-blocking (kernel buffers up to 64KB), so a long playback never
# stalls the SSE-read loop.
#
# Why two launchctl agents: a wedged audio device crashes only the player;
# the listener stays attached to SSE. A wedged stream crashes only the
# listener; the player drains pending FIFO bytes and waits for new ones.
# `KeepAlive` in both plists handles respawn within seconds.
#
# Spec: openspec/changes/add-tts-playback-queue/

set -uo pipefail

# ── Helpers (single source of truth, used by both modes) ────────────────────

NEXUS_URL="${NEXUS_URL:-http://homelab:7400}"
LOG_FILE="${NEXUS_NOTIFIER_LOG:-$HOME/Library/Logs/nexus-notifier.log}"
DRAIN_LOG="${NEXUS_TTS_PLAYER_LOG:-$HOME/Library/Logs/nexus-tts-player.log}"

# FIFO path lives alongside the agent's other runtime state under
# ~/Library/Application Support/nexus/. /tmp was rejected because the FIFO
# surviving a soft restart helps debugging; ~/.config/nexus is for *config*.
NEXUS_NOTIFIER_FIFO="${NEXUS_NOTIFIER_FIFO:-$HOME/Library/Application Support/nexus/tts-queue.fifo}"

_load_secret() {
  if [ -z "${NEXUS_ATTACH_SECRET:-}" ] && [ -f "$HOME/.env" ]; then
    # shellcheck disable=SC1091
    set -a; . "$HOME/.env"; set +a
  fi
  if [ -z "${NEXUS_ATTACH_SECRET:-}" ]; then
    echo "[$(date)] NEXUS_ATTACH_SECRET not set — cannot authenticate" >> "$LOG_FILE"
    exit 1
  fi
}

# Idempotently (re)create the FIFO with mode 0600. Stale FIFOs are purged
# at startup — see spec § "Restart semantics SHALL be ephemeral".
_ensure_fifo() {
  local fifo_dir
  fifo_dir="$(dirname "$NEXUS_NOTIFIER_FIFO")"
  /bin/mkdir -p "$fifo_dir"
  if [ -e "$NEXUS_NOTIFIER_FIFO" ] && [ ! -p "$NEXUS_NOTIFIER_FIFO" ]; then
    # Path exists but isn't a FIFO — refuse to clobber a regular file.
    echo "[$(date)] $NEXUS_NOTIFIER_FIFO exists and is not a FIFO; aborting" >> "$LOG_FILE"
    exit 1
  fi
  /bin/rm -f "$NEXUS_NOTIFIER_FIFO" 2>/dev/null || true
  /usr/bin/mkfifo "$NEXUS_NOTIFIER_FIFO" 2>>"$LOG_FILE" || true
  /bin/chmod 0600 "$NEXUS_NOTIFIER_FIFO" 2>>"$LOG_FILE" || true
}

_escape_for_applescript() {
  # Escape double quotes + backslashes for AppleScript string literal.
  printf '%s' "$1" | /usr/bin/sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# ── Emoji → PNG renderer with on-disk cache ─────────────────────────────────
ICON_CACHE_DIR="$HOME/Library/Application Support/nexus/icons"

_nx_render_emoji_png() {
  local emoji="$1" out="$2"
  /usr/bin/swift - "$emoji" "$out" 2>>"$LOG_FILE" <<'SWIFT'
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count == 3 else { exit(1) }
let emoji = args[1]
let outPath = args[2]
let size: CGFloat = 1024

let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()

NSColor.clear.set()
NSRect(x: 0, y: 0, width: size, height: size).fill()

let style = NSMutableParagraphStyle()
style.alignment = .center

let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: size * 0.85),
    .paragraphStyle: style,
]
let str = NSAttributedString(string: emoji, attributes: attrs)
let strSize = str.size()
let y = (size - strSize.height) / 2.0
str.draw(in: NSRect(x: 0, y: y, width: size, height: strSize.height))

img.unlockFocus()

guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    exit(1)
}
do {
    try png.write(to: URL(fileURLWithPath: outPath))
} catch {
    exit(1)
}
SWIFT
}

_nx_ensure_emoji_icon() {
  local emoji="$1"
  [ -z "$emoji" ] && return 1
  /bin/mkdir -p "$ICON_CACHE_DIR"
  local key
  key=$(printf '%s' "$emoji" | /usr/bin/shasum -a 256 | /usr/bin/head -c 16)
  local out="$ICON_CACHE_DIR/$key.png"
  if [ ! -f "$out" ]; then
    _nx_render_emoji_png "$emoji" "$out" || return 1
    [ -f "$out" ] || return 1
  fi
  printf '%s' "$out"
}

_nx_leading_emoji() {
  local title="$1"
  local first="${title%% *}"
  printf '%s' "$first"
}

_dispatch_banner() {
  local title="$1" body="$2" project="${3:-}"

  local emoji name
  emoji=$(_nx_leading_emoji "$title")
  if [ -n "$emoji" ] && [ "$emoji" != "$title" ]; then
    name="${title#$emoji }"
  else
    name=""
    emoji=""
  fi

  local bundle_id=""
  if [ -x "$HOME/bin/nexus-bundle-manager.sh" ]; then
    if [ -n "$project" ] && [ -n "$emoji" ] && [ -n "$name" ]; then
      bundle_id=$("$HOME/bin/nexus-bundle-manager.sh" ensure "$project" "$emoji" "$name" 2>>"$LOG_FILE") || bundle_id=""
    fi
    if [ -z "$bundle_id" ]; then
      bundle_id=$("$HOME/bin/nexus-bundle-manager.sh" ensure-default 2>>"$LOG_FILE") || bundle_id=""
    fi
  fi

  local icon=""
  if [ -n "$emoji" ]; then
    icon=$(_nx_ensure_emoji_icon "$emoji" 2>/dev/null) || icon=""
  fi

  local tn
  for tn in /opt/homebrew/bin/terminal-notifier /usr/local/bin/terminal-notifier; do
    if [ -x "$tn" ]; then
      local args=(-title "$title" -message "$body")
      [ -n "$bundle_id" ] && args+=(-sender "$bundle_id")
      [ -n "$icon" ] && [ -f "$icon" ] && args+=(-contentImage "$icon")
      "$tn" "${args[@]}" 2>>"$LOG_FILE" >/dev/null
      return
    fi
  done

  local esc_title esc_body
  esc_title=$(_escape_for_applescript "$title")
  esc_body=$(_escape_for_applescript "$body")
  /usr/bin/osascript -e "display notification \"$esc_body\" with title \"$esc_title\"" 2>>"$LOG_FILE"
}

# Producer-side TTS dispatch — non-blocking write to the FIFO. Reverse of the
# old `say "$body" &` which spawned overlapping processes. The drain worker
# (run separately as `nexus-notifier.sh drain`) reads lines and synthesizes
# them serially.
_dispatch_tts() {
  local body="$1"
  printf '%s\n' "$body" >> "$NEXUS_NOTIFIER_FIFO" 2>>"$LOG_FILE"
}

_process_event() {
  local payload="$1"
  local channel body title project
  channel=$(printf '%s' "$payload" | /usr/bin/jq -r '.payload.channel // empty' 2>/dev/null)
  body=$(printf '%s' "$payload" | /usr/bin/jq -r '.payload.body // .payload.message // empty' 2>/dev/null)
  title=$(printf '%s' "$payload" | /usr/bin/jq -r '.payload.title // .payload.project // "Claude Code"' 2>/dev/null)
  project=$(printf '%s' "$payload" | /usr/bin/jq -r '.payload.project // empty' 2>/dev/null)

  [ -z "$body" ] && return 0

  case "$channel" in
    desktop|banner)
      _dispatch_banner "$title" "$body" "$project"
      echo "[$(date)] banner: [$title] $body" >> "$LOG_FILE"
      ;;
    tts)
      _dispatch_banner "$title" "$body" "$project"
      _dispatch_tts "$body"
      echo "[$(date)] tts+banner: [$title] $body" >> "$LOG_FILE"
      ;;
    desktop,tts|tts,desktop|*desktop*tts*|*tts*desktop*)
      _dispatch_banner "$title" "$body" "$project"
      _dispatch_tts "$body"
      echo "[$(date)] both: [$title] $body" >> "$LOG_FILE"
      ;;
    slack|"")
      :
      ;;
    *)
      echo "[$(date)] unknown channel: $channel" >> "$LOG_FILE"
      ;;
  esac
}

# ── Event dedup (listen mode only) ──────────────────────────────────────────
DEDUP_WINDOW="${NEXUS_NOTIFIER_DEDUP_WINDOW:-30}"
LAST_DEDUP_ID=""
LAST_DEDUP_TS=0

_should_skip_dup() {
  local id="$1"
  [ -z "$id" ] && return 1
  local now
  now=$(/bin/date +%s)
  if [ "$id" = "$LAST_DEDUP_ID" ] && [ $((now - LAST_DEDUP_TS)) -lt "$DEDUP_WINDOW" ]; then
    return 0
  fi
  LAST_DEDUP_ID="$id"
  LAST_DEDUP_TS="$now"
  return 1
}

_run_stream() {
  local event_name=""
  while IFS= read -r line; do
    case "$line" in
      "event: "*)
        event_name="${line#event: }"
        ;;
      "data: "*)
        if [ "$event_name" = "NotificationFired" ]; then
          local data="${line#data: }"
          local id
          id=$(printf '%s' "$data" | /usr/bin/jq -r '.payload.id // empty' 2>/dev/null)
          if _should_skip_dup "$id"; then
            echo "[$(date)] dedup skipped id=$id" >> "$LOG_FILE"
          else
            _process_event "$data"
          fi
        fi
        event_name=""
        ;;
      "")
        event_name=""
        ;;
    esac
  done < <(/usr/bin/curl -sN --no-buffer --max-time 0 \
    -H "Accept: text/event-stream" \
    -H "x-nexus-secret: $NEXUS_ATTACH_SECRET" \
    "$NEXUS_URL/events/stream" 2>>"$LOG_FILE")
}

# ── Mode: listen ────────────────────────────────────────────────────────────

_run_listen() {
  _load_secret
  _ensure_fifo
  echo "[$(date)] nexus-notifier (listen) starting — url=$NEXUS_URL fifo=$NEXUS_NOTIFIER_FIFO" >> "$LOG_FILE"
  while true; do
    _run_stream
    echo "[$(date)] stream disconnected, reconnecting in 5s" >> "$LOG_FILE"
    sleep 5
  done
}

# ── Mode: drain ─────────────────────────────────────────────────────────────
#
# Read one line at a time from the FIFO and synthesize it via /usr/bin/say.
# The 60-second timeout caps any single utterance — if `say` ever hangs on
# a wedged audio device or a million-character body, the queue advances
# instead of stalling forever. See design.md § "Why a 60-second timeout".

_run_drain() {
  _ensure_fifo
  echo "[$(date)] nexus-tts-player (drain) starting — fifo=$NEXUS_NOTIFIER_FIFO" >> "$DRAIN_LOG"
  # The `< "$FIFO"` redirect blocks until a writer attaches — this is exactly
  # the semantics we want: no busy-wait, no polling.
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      /usr/bin/timeout 60 /usr/bin/say -- "$line" 2>>"$DRAIN_LOG" || \
        echo "[$(date)] say timed out or failed: $line" >> "$DRAIN_LOG"
    fi
  done < "$NEXUS_NOTIFIER_FIFO"
  # If the FIFO closes (all writers detached and EOF observed), the loop
  # exits — launchctl `KeepAlive` will relaunch us within a second or two.
  echo "[$(date)] drain loop exited (FIFO EOF) — exiting for KeepAlive respawn" >> "$DRAIN_LOG"
}

# ── Mode dispatcher ─────────────────────────────────────────────────────────

case "${1:-listen}" in
  listen)
    _run_listen
    ;;
  drain)
    _run_drain
    ;;
  *)
    echo "usage: $0 [listen|drain]" >&2
    exit 2
    ;;
esac
