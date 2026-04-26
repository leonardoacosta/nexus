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

_dispatch_banner() {
  local title="$1" body="$2"

  # Prefer terminal-notifier when installed: it owns its own bundle ID
  # (`nu.dougal.terminal-notifier`) so macOS can grant it Notification
  # permission independently. osascript routes through Script Editor's
  # bundle, which is often unprivileged and silently suppresses banners.
  local tn
  for tn in /opt/homebrew/bin/terminal-notifier /usr/local/bin/terminal-notifier; do
    if [ -x "$tn" ]; then
      "$tn" -title "$title" -message "$body" 2>>"$LOG_FILE" >/dev/null
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
  local channel body title
  channel=$(printf '%s' "$payload" | /usr/bin/jq -r '.payload.channel // empty' 2>/dev/null)
  body=$(printf '%s' "$payload" | /usr/bin/jq -r '.payload.body // .payload.message // empty' 2>/dev/null)
  title=$(printf '%s' "$payload" | /usr/bin/jq -r '.payload.title // .payload.project // "Claude Code"' 2>/dev/null)

  [ -z "$body" ] && return 0

  case "$channel" in
    desktop|banner)
      _dispatch_banner "$title" "$body"
      echo "[$(date)] banner: [$title] $body" >> "$LOG_FILE"
      ;;
    tts)
      # `tts` from the agent fans out into BOTH a banner AND speech: the
      # agent rejects multi-channel strings ("desktop,tts"), and users who
      # ask to be notified almost always want both senses. Pass channel=
      # "desktop" upstream when you specifically want a silent banner.
      _dispatch_banner "$title" "$body"
      _dispatch_tts "$body"
      echo "[$(date)] tts+banner: [$title] $body" >> "$LOG_FILE"
      ;;
    desktop,tts|tts,desktop|*desktop*tts*|*tts*desktop*)
      _dispatch_banner "$title" "$body"
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

_run_stream() {
  # SSE frame format:
  #   event: NotificationFired
  #   data: {"event":"NotificationFired","payload":{...},"source":"local",...}
  #   <blank line>
  #
  # We track two-line state: event name then data line.
  local event_name=""
  /usr/bin/curl -sN --no-buffer --max-time 0 \
    -H "Accept: text/event-stream" \
    -H "x-nexus-secret: $NEXUS_ATTACH_SECRET" \
    "$NEXUS_URL/events/stream" 2>>"$LOG_FILE" | \
  while IFS= read -r line; do
    case "$line" in
      "event: "*)
        event_name="${line#event: }"
        ;;
      "data: "*)
        if [ "$event_name" = "NotificationFired" ]; then
          _process_event "${line#data: }"
        fi
        event_name=""
        ;;
      "")
        event_name=""
        ;;
    esac
  done
}

echo "[$(date)] nexus-notifier starting — url=$NEXUS_URL" >> "$LOG_FILE"

while true; do
  _run_stream
  echo "[$(date)] stream disconnected, reconnecting in 5s" >> "$LOG_FILE"
  sleep 5
done
