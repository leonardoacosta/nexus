#!/usr/bin/env bash
# nexus-notifier.sh — Mac-side listener for nexus NotificationFired events.
#
# Subscribes to the nexus-agent SSE stream on homelab via Tailscale,
# filters for NotificationFired events, and dispatches native Mac
# notifications:
#
#   channel=desktop → terminal-notifier banner (falls back to osascript)
#   channel=tts     → say (macOS built-in TTS)
#   channel=slack   → ignored (server-side webhook handles this)
#
# Why terminal-notifier > osascript: osascript routes notifications through
# Script Editor's bundle ID, which gets a separate Notification permission
# entry in System Settings — and macOS silently suppresses the banner if
# that permission was never granted. terminal-notifier ships its own bundle
# (`nu.dougal.terminal-notifier`) and shows up as its own row in System
# Settings → Notifications, making the permission grant straightforward.
#
# Reconnects on stream disconnect with 5-second backoff. Runs as a
# launchd agent via ~/Library/LaunchAgents/com.nexus.notifier.plist.
#
# Environment:
#   NEXUS_URL              — default http://homelab:7400
#   NEXUS_ATTACH_SECRET    — required (match nexus-agent's secret)
#   NEXUS_NOTIFIER_LOG     — default ~/Library/Logs/nexus-notifier.log
#
# Install:
#   scp this file to ~/bin/nexus-notifier.sh on Mac
#   chmod +x ~/bin/nexus-notifier.sh
#   launchctl load ~/Library/LaunchAgents/com.nexus.notifier.plist

set -u

NEXUS_URL="${NEXUS_URL:-http://homelab:7400}"
LOG_FILE="${NEXUS_NOTIFIER_LOG:-$HOME/Library/Logs/nexus-notifier.log}"

# Load secret from ~/.env if not already set (mirrors Linux side)
if [ -z "${NEXUS_ATTACH_SECRET:-}" ] && [ -f "$HOME/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$HOME/.env"; set +a
fi

if [ -z "${NEXUS_ATTACH_SECRET:-}" ]; then
  echo "[$(date)] NEXUS_ATTACH_SECRET not set — cannot authenticate" >> "$LOG_FILE"
  exit 1
fi

_escape_for_applescript() {
  # Escape double quotes + backslashes for AppleScript string literal.
  printf '%s' "$1" | /usr/bin/sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# ── Emoji → PNG renderer with on-disk cache ─────────────────────────────────
#
# Renders an emoji to a 1024×1024 PNG using Apple Color Emoji (via Cocoa).
# Caches the result keyed by the emoji's SHA-256 prefix so subsequent calls
# are instant (Swift startup is ~1–2s, so first-call-per-emoji cost is
# amortized over every future banner that uses the same project).
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

// Transparent background — let the OS round-corner the icon.
NSColor.clear.set()
NSRect(x: 0, y: 0, width: size, height: size).fill()

let style = NSMutableParagraphStyle()
style.alignment = .center

// 0.85 leaves ~7.5% margin on each side so the emoji doesn't bleed.
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
  # SHA-256 prefix as cache key — composite emojis (ZWJ-joined) hash distinctly.
  local key
  key=$(printf '%s' "$emoji" | /usr/bin/shasum -a 256 | /usr/bin/head -c 16)
  local out="$ICON_CACHE_DIR/$key.png"
  if [ ! -f "$out" ]; then
    _nx_render_emoji_png "$emoji" "$out" || return 1
    [ -f "$out" ] || return 1
  fi
  printf '%s' "$out"
}

# Pull the leading "word" from a title — for a title like "🔭 Nexus"
# this returns "🔭" (composite emojis like 👨‍💻 stay intact because
# parameter expansion splits on the space, not the ZWJ joiners).
_nx_leading_emoji() {
  local title="$1"
  local first="${title%% *}"
  printf '%s' "$first"
}

_dispatch_banner() {
  local title="$1" body="$2" project="${3:-}"

  # Decompose the title — assumes the agent emits "<emoji> <name>" via
  # the auto-detect path in nx-send.sh. If the title has no leading emoji
  # we skip the bundle path and fall back to terminal-notifier's default
  # icon; the contentImage slot stays empty in that case too.
  local emoji name
  emoji=$(_nx_leading_emoji "$title")
  if [ -n "$emoji" ] && [ "$emoji" != "$title" ]; then
    name="${title#$emoji }"
  else
    name=""
    emoji=""
  fi

  # Lazy-create a per-project .app bundle so terminal-notifier can pass
  # `-sender <bundle-id>` and have macOS render the project's emoji as
  # the LEFT app-icon. Bundle creation is idempotent (no-op if exists).
  # When no project context is available, fall back to the generic
  # Nexus bundle (also lazy-created) so the LEFT slot still says "Nexus"
  # instead of terminal-notifier's default icon.
  local bundle_id=""
  if [ -x "$HOME/bin/nexus-bundle-manager.sh" ]; then
    if [ -n "$project" ] && [ -n "$emoji" ] && [ -n "$name" ]; then
      bundle_id=$("$HOME/bin/nexus-bundle-manager.sh" ensure "$project" "$emoji" "$name" 2>>"$LOG_FILE") || bundle_id=""
    fi
    if [ -z "$bundle_id" ]; then
      bundle_id=$("$HOME/bin/nexus-bundle-manager.sh" ensure-default 2>>"$LOG_FILE") || bundle_id=""
    fi
  fi

  # contentImage stays as the project emoji PNG so the RIGHT slot of the
  # banner reinforces the project identity even when -sender resolution
  # fails (e.g. lsregister hasn't picked up a brand-new bundle yet).
  local icon=""
  if [ -n "$emoji" ]; then
    icon=$(_nx_ensure_emoji_icon "$emoji" 2>/dev/null) || icon=""
  fi

  # Prefer terminal-notifier when installed: it owns its own bundle ID
  # (`nu.dougal.terminal-notifier`) so macOS can grant it Notification
  # permission independently. osascript routes through Script Editor's
  # bundle, which is often unprivileged and silently suppresses banners.
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

  # Fallback: osascript. Works only when Script Editor (or the calling
  # terminal app) has Notification permission in System Settings.
  local esc_title esc_body
  esc_title=$(_escape_for_applescript "$title")
  esc_body=$(_escape_for_applescript "$body")
  /usr/bin/osascript -e "display notification \"$esc_body\" with title \"$esc_title\"" 2>>"$LOG_FILE"
}

_dispatch_tts() {
  local body="$1"
  # `say` blocks until playback finishes; backgrounded so the listener
  # keeps reading the SSE stream without delay.
  /usr/bin/say -- "$body" 2>>"$LOG_FILE" &
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
      # `tts` from the agent fans out into BOTH a banner AND speech: the
      # agent rejects multi-channel strings ("desktop,tts"), and users who
      # ask to be notified almost always want both senses. Pass channel=
      # "desktop" upstream when you specifically want a silent banner.
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
      # Slack handled server-side; empty channel = ignore
      :
      ;;
    *)
      echo "[$(date)] unknown channel: $channel" >> "$LOG_FILE"
      ;;
  esac
}

# ── Event dedup ─────────────────────────────────────────────────────────────
#
# The lifecycle bus has a known peer-echo loop where a notification fired on
# Linux can be forwarded to Mac, re-emitted, and re-pushed onto the same SSE
# stream — surfacing as "the same banner twice with a delay". Until that
# loop is fixed at the bus layer, we dedupe in the listener: if we see the
# same payload.id within DEDUP_WINDOW seconds we drop the second copy.
#
# Why these vars are at script scope and the loop uses process substitution:
# `cmd | while read` runs the loop in a forked subshell, so any `LAST_*=`
# assignments inside it die the moment the pipe closes. `while read; done <
# <(cmd)` keeps the loop in the parent shell so dedup state persists across
# events.
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
  # SSE frame format:
  #   event: NotificationFired
  #   data: {"event":"NotificationFired","payload":{...},"source":"local",...}
  #   <blank line>
  #
  # We track two-line state: event name then data line.
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

echo "[$(date)] nexus-notifier starting — url=$NEXUS_URL" >> "$LOG_FILE"

while true; do
  _run_stream
  echo "[$(date)] stream disconnected, reconnecting in 5s" >> "$LOG_FILE"
  sleep 5
done
