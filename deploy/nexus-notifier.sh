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
# Wave 3 layers (audio dispatch + dashboard control), merged in-place atop
# the legacy FIFO/say pipeline:
#
#   * On-startup GET ${NEXUS_URL}/notifications/settings caches TTS_ENABLED,
#     BANNER_ENABLED, DUCKING_MODE. SSE `SettingsChanged` frames update the
#     cache in place — no restart required.
#   * NotificationFired frames carrying `payload.audioBase64` (pre-synthesized
#     mp3 bytes) are decoded to /tmp/nexus-notifier-<uuid>.mp3 and played
#     via /usr/bin/afplay; cleanup runs after afplay exits. When audioBase64
#     is absent (signal-only — no key, upstream call failed), the dispatch
#     falls through to the legacy FIFO + `say` pipeline so Leo still hears
#     every notification.
#   * Banner dispatch is guarded by BANNER_ENABLED. TTS dispatch (both the
#     afplay path and the legacy FIFO+say path) is guarded by TTS_ENABLED.
#   * DUCKING_MODE wraps audio playback in a save/set/restore of the system
#     output volume (half) or muted state (mute). `full` and the legacy
#     plist value `none` are no-ops.
#
# Spec: openspec/changes/add-tts-playback-queue/
#       openspec/changes/restore-tts-mac-audio-dispatch/
#       openspec/changes/add-notification-control-dashboard/

set -uo pipefail

# ── Helpers (single source of truth, used by both modes) ────────────────────

NEXUS_URL="${NEXUS_URL:-http://localhost:7400}"
LOG_FILE="${NEXUS_NOTIFIER_LOG:-$HOME/Library/Logs/nexus-notifier.log}"
DRAIN_LOG="${NEXUS_TTS_PLAYER_LOG:-$HOME/Library/Logs/nexus-tts-player.log}"
# Suppression cross-reference log — every "TTS-suppressed" / "banner-suppressed"
# line is mirrored here so `tail -f ~/Library/Logs/nexus-notifier.out.log`
# (StandardOutPath) shows them alongside launchd output. The dashboard
# table consults this file to render "listener saw it but suppressed" rows.
SUPPRESS_LOG="${NEXUS_NOTIFIER_SUPPRESS_LOG:-$HOME/Library/Logs/nexus-notifier.out.log}"

# FIFO path lives alongside the agent's other runtime state under
# ~/Library/Application Support/nexus/. /tmp was rejected because the FIFO
# surviving a soft restart helps debugging; ~/.config/nexus is for *config*.
NEXUS_NOTIFIER_FIFO="${NEXUS_NOTIFIER_FIFO:-$HOME/Library/Application Support/nexus/tts-queue.fifo}"

# ── Cached settings ─────────────────────────────────────────────────────────
# Seeded from plist EnvironmentVariables, then overwritten by the GET
# /notifications/settings call in _bootstrap_settings. SSE SettingsChanged
# frames mutate these in place (see _process_settings_changed).
#
# Canonical values are "true" / "false" (matching the JSON wire format).
# Legacy plist values "1" / "0" are normalized on read. DUCKING_MODE
# canonical values are "full" | "half" | "mute"; the legacy plist value
# "none" is normalized to "full" (no-op).
TTS_ENABLED="${TTS_ENABLED:-true}"
BANNER_ENABLED="${BANNER_ENABLED:-true}"
DUCKING_MODE="${DUCKING_MODE:-full}"

# Volume-restoration state used by _apply_ducking / _restore_ducking. The
# saved values are populated only when DUCKING_MODE != full; restore is a
# no-op when nothing was saved.
_SAVED_VOLUME=""
_SAVED_MUTED=""

# Suppression log helper — writes a parallel line into SUPPRESS_LOG so the
# dashboard table can cross-reference events that were persisted server-side
# but silenced client-side. Also tee'd into LOG_FILE for unified tailing.
_log_suppressed() {
  local ts msg
  ts="$(/bin/date '+%Y-%m-%d %H:%M:%S')"
  msg="$*"
  printf '[%s] %s\n' "$ts" "$msg" >> "$LOG_FILE"
  printf '[%s] %s\n' "$ts" "$msg" >> "$SUPPRESS_LOG" 2>/dev/null || true
}

# ── Settings normalization ─────────────────────────────────────────────────
# The plist historically used "1"/"0" while the API returns "true"/"false".
# Normalize to canonical "true"/"false" / "full"|"half"|"mute" so downstream
# guards have one shape to compare against.
_normalize_bool() {
  case "$1" in
    1|true|TRUE|True|yes|on)    printf 'true' ;;
    0|false|FALSE|False|no|off) printf 'false' ;;
    *)                          printf 'true' ;;  # default-true on garbage input — least surprise
  esac
}

_normalize_ducking() {
  case "$1" in
    full|half|mute) printf '%s' "$1" ;;
    none|"")        printf 'full' ;;  # legacy plist value -> full (no-op)
    *)              printf 'full' ;;
  esac
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

# ── UUID helper ────────────────────────────────────────────────────────────
# Uses `uuidgen` when available (every macOS ships it under /usr/bin), with
# an openssl fallback for hardened systems where uuidgen is suppressed.
_gen_uuid() {
  if [ -x /usr/bin/uuidgen ]; then
    /usr/bin/uuidgen
  elif command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    # Last-ditch: epoch + pid. Not collision-proof but every dispatch is
    # serialized through this single process so collisions only happen on
    # clock skew during a wraparound — vanishingly rare on a Mac.
    printf '%s-%s' "$(/bin/date +%s)" "$$"
  fi
}

# ── Settings bootstrap ─────────────────────────────────────────────────────
# GET /notifications/settings on startup. Cache into TTS_ENABLED /
# BANNER_ENABLED / DUCKING_MODE. Tolerate 404 (first-install before the
# dashboard migration has run) and any HTTP failure by falling back to the
# spec defaults: tts=true, banner=true, ducking=full.
_bootstrap_settings() {
  local response http_code body
  response="$(/usr/bin/curl -sS -m 5 -w '\n%{http_code}' \
    "$NEXUS_URL/notifications/settings" 2>>"$LOG_FILE")" || response=""

  http_code="$(printf '%s' "$response" | /usr/bin/tail -n1)"
  body="$(printf '%s' "$response" | /usr/bin/sed '$d')"

  if [ "$http_code" = "200" ]; then
    local tts banner ducking
    tts=$(printf '%s' "$body" | /usr/bin/jq -r '.tts_enabled // .ttsEnabled // empty' 2>/dev/null)
    banner=$(printf '%s' "$body" | /usr/bin/jq -r '.banner_enabled // .bannerEnabled // empty' 2>/dev/null)
    ducking=$(printf '%s' "$body" | /usr/bin/jq -r '.ducking_mode // .duckingMode // empty' 2>/dev/null)
    TTS_ENABLED="$(_normalize_bool "${tts:-true}")"
    BANNER_ENABLED="$(_normalize_bool "${banner:-true}")"
    DUCKING_MODE="$(_normalize_ducking "${ducking:-full}")"
    echo "[$(date)] settings bootstrapped tts=$TTS_ENABLED banner=$BANNER_ENABLED ducking=$DUCKING_MODE" >> "$LOG_FILE"
  else
    # 404 (table not migrated yet) or any non-200 — fall back to spec defaults.
    TTS_ENABLED="true"
    BANNER_ENABLED="true"
    DUCKING_MODE="full"
    echo "[$(date)] settings GET failed (http=$http_code); using defaults tts=true banner=true ducking=full" >> "$LOG_FILE"
  fi
}

# ── SSE SettingsChanged handler ────────────────────────────────────────────
# In-place update of the cached vars. Triggered from _run_stream when the
# event_name matches "SettingsChanged".
_process_settings_changed() {
  local data="$1" tts banner ducking
  tts=$(printf '%s' "$data" | /usr/bin/jq -r '.payload.ttsEnabled // .payload.tts_enabled // empty' 2>/dev/null)
  banner=$(printf '%s' "$data" | /usr/bin/jq -r '.payload.bannerEnabled // .payload.banner_enabled // empty' 2>/dev/null)
  ducking=$(printf '%s' "$data" | /usr/bin/jq -r '.payload.duckingMode // .payload.ducking_mode // empty' 2>/dev/null)
  if [ -n "$tts" ];     then TTS_ENABLED="$(_normalize_bool "$tts")"; fi
  if [ -n "$banner" ];  then BANNER_ENABLED="$(_normalize_bool "$banner")"; fi
  if [ -n "$ducking" ]; then DUCKING_MODE="$(_normalize_ducking "$ducking")"; fi
  echo "[$(date)] SettingsChanged applied tts=$TTS_ENABLED banner=$BANNER_ENABLED ducking=$DUCKING_MODE" >> "$LOG_FILE"
}

# ── Audio ducking ──────────────────────────────────────────────────────────
# Apply DUCKING_MODE *before* afplay/say; populate _SAVED_* so _restore_ducking
# can roll the system back to its prior state once playback completes.
#
# `osascript -e "output volume of (get volume settings)"` returns an int 0–100.
# `osascript -e "output muted of (get volume settings)"` returns "true"/"false".
_apply_ducking() {
  _SAVED_VOLUME=""
  _SAVED_MUTED=""
  case "$DUCKING_MODE" in
    full)
      : # no-op
      ;;
    half)
      _SAVED_VOLUME="$(/usr/bin/osascript -e 'output volume of (get volume settings)' 2>/dev/null || printf '')"
      /usr/bin/osascript -e "set volume output volume 25" >/dev/null 2>&1 || true
      echo "[$(date)] ducking half — saved_volume=${_SAVED_VOLUME:-?} -> 25" >> "$LOG_FILE"
      ;;
    mute)
      _SAVED_MUTED="$(/usr/bin/osascript -e 'output muted of (get volume settings)' 2>/dev/null || printf '')"
      /usr/bin/osascript -e "set volume with output muted" >/dev/null 2>&1 || true
      echo "[$(date)] ducking mute — saved_muted=${_SAVED_MUTED:-?} -> true" >> "$LOG_FILE"
      ;;
  esac
}

_restore_ducking() {
  if [ -n "$_SAVED_VOLUME" ]; then
    /usr/bin/osascript -e "set volume output volume ${_SAVED_VOLUME}" >/dev/null 2>&1 || true
    echo "[$(date)] ducking restored — volume=$_SAVED_VOLUME" >> "$LOG_FILE"
    _SAVED_VOLUME=""
  fi
  if [ "$_SAVED_MUTED" = "false" ]; then
    /usr/bin/osascript -e "set volume without output muted" >/dev/null 2>&1 || true
    echo "[$(date)] ducking restored — unmuted" >> "$LOG_FILE"
    _SAVED_MUTED=""
  elif [ "$_SAVED_MUTED" = "true" ]; then
    # Was already muted before we touched it — leave it muted.
    _SAVED_MUTED=""
  fi
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

  # Banner suppression — short-circuit when the dashboard has flipped the
  # banner channel off. Keep the cross-reference log line so we can prove
  # "listener saw it but suppressed" downstream.
  if [ "$BANNER_ENABLED" = "false" ]; then
    _log_suppressed "banner suppressed (banner_enabled=false) title=\"$title\""
    return 0
  fi

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

  # TTS suppression — accept the canonical "false" plus the legacy plist
  # value "0" so an old plist doesn't suddenly start playing audio. Guard
  # *both* the FIFO-write path and the afplay path on the same flag so the
  # dashboard toggle behaves identically regardless of which side the agent
  # took.
  if [ "${TTS_ENABLED}" = "false" ] || [ "${TTS_ENABLED}" = "0" ]; then
    _log_suppressed "tts suppressed (tts_enabled=$TTS_ENABLED) body=\"$body\""
    return 0
  fi

  printf '%s\n' "$body" >> "$NEXUS_NOTIFIER_FIFO" 2>>"$LOG_FILE"
}

# ── Audio dispatch (audioBase64 path) ──────────────────────────────────────
#
# `audio_b64` is the mp3 payload as decoded by jq -r from payload.audioBase64.
# The empty string means signal-only — fall through to the FIFO+say pipeline
# (legacy behavior preserved for offline-key / upstream-failure cases).
_dispatch_audio() {
  local audio_b64="$1" body="$2"

  # TTS suppression — same rule as _dispatch_tts. Logged once at the top so
  # the suppression cross-reference covers both paths.
  if [ "${TTS_ENABLED}" = "false" ] || [ "${TTS_ENABLED}" = "0" ]; then
    _log_suppressed "tts suppressed (tts_enabled=$TTS_ENABLED) body=\"$body\""
    return 0
  fi

  if [ -z "$audio_b64" ]; then
    # No pre-synthesized audio — defer to the FIFO+say pipeline so the drain
    # worker plays this serially alongside any queued items. _dispatch_tts
    # re-checks TTS_ENABLED but that's free; keeping the guard there makes
    # _dispatch_tts safe for legacy callers too.
    _dispatch_tts "$body"
    return 0
  fi

  # Ducking applies for the afplay path. Save state up-front; the cleanup
  # subshell restores after afplay exits.
  _apply_ducking

  local uuid tmp
  uuid="$(_gen_uuid)"
  tmp="/tmp/nexus-notifier-${uuid}.mp3"

  # macOS base64 reads stdin; -d decodes, -o writes to a path. We pipe
  # via printf to avoid a temp .b64 file (and to side-step shells that
  # mangle large args).
  if ! printf '%s' "$audio_b64" | /usr/bin/base64 -d -o "$tmp" 2>>"$LOG_FILE"; then
    echo "[$(date)] base64 decode failed; falling back to FIFO say" >> "$LOG_FILE"
    # Decode failure → restore ducking now (no afplay will fire), then
    # defer to the FIFO so the drain worker handles it serially.
    _restore_ducking
    _dispatch_tts "$body"
    return 0
  fi

  # Background afplay so the SSE loop never blocks on playback. Trail
  # the cleanup with a subshell that waits for afplay's PID, then unlinks
  # the temp file *and* restores the pre-ducking volume/mute state.
  /usr/bin/afplay "$tmp" >>"$LOG_FILE" 2>&1 &
  local afpid=$!
  ( wait "$afpid" 2>/dev/null; /bin/rm -f "$tmp" 2>/dev/null; _restore_ducking ) &
  echo "[$(date)] afplay scheduled pid=$afpid path=$tmp ducking=$DUCKING_MODE" >> "$LOG_FILE"
}

_process_event() {
  local payload="$1"
  local channel body title project audio_b64
  channel=$(printf '%s' "$payload" | /usr/bin/jq -r '.payload.channel // empty' 2>/dev/null)
  body=$(printf '%s' "$payload" | /usr/bin/jq -r '.payload.body // .payload.message // empty' 2>/dev/null)
  title=$(printf '%s' "$payload" | /usr/bin/jq -r '.payload.title // .payload.project // "Claude Code"' 2>/dev/null)
  project=$(printf '%s' "$payload" | /usr/bin/jq -r '.payload.project // empty' 2>/dev/null)
  audio_b64=$(printf '%s' "$payload" | /usr/bin/jq -r '.payload.audioBase64 // empty' 2>/dev/null)

  [ -z "$body" ] && return 0

  case "$channel" in
    desktop|banner)
      _dispatch_banner "$title" "$body" "$project"
      echo "[$(date)] banner: [$title] $body" >> "$LOG_FILE"
      ;;
    tts)
      _dispatch_banner "$title" "$body" "$project"
      _dispatch_audio "$audio_b64" "$body"
      echo "[$(date)] tts+banner: [$title] $body" >> "$LOG_FILE"
      ;;
    desktop,tts|tts,desktop|*desktop*tts*|*tts*desktop*)
      _dispatch_banner "$title" "$body" "$project"
      _dispatch_audio "$audio_b64" "$body"
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
        case "$event_name" in
          NotificationFired)
            local data="${line#data: }"
            local id
            id=$(printf '%s' "$data" | /usr/bin/jq -r '.payload.id // empty' 2>/dev/null)
            if _should_skip_dup "$id"; then
              echo "[$(date)] dedup skipped id=$id" >> "$LOG_FILE"
            else
              _process_event "$data"
            fi
            ;;
          SettingsChanged)
            # Apply settings update without restarting the listener. The
            # cached vars TTS_ENABLED / BANNER_ENABLED / DUCKING_MODE are
            # mutated in-place inside this process.
            _process_settings_changed "${line#data: }"
            ;;
        esac
        event_name=""
        ;;
      "")
        event_name=""
        ;;
    esac
  # `--max-time 1800` forces a reconnect every 30 minutes so a half-open
  # TCP socket (Mac wifi sleep, Tailscale wake-from-sleep, NAT timeout) can
  # never wedge the listener indefinitely. The previous `--max-time 0` left
  # curl in a forever-blocked read() when a connection silently died — no
  # FIN/RST ever arrived, so the outer reconnect loop never fired.
  #
  # `--keepalive-time 60` enables TCP-level keepalive probes every 60s
  # (much tighter than the OS default of ~2 hours). When the peer is gone,
  # the kernel returns ETIMEDOUT to curl and the loop reconnects.
  done < <(/usr/bin/curl -sN --no-buffer \
    --max-time 1800 \
    --keepalive-time 60 \
    -H "Accept: text/event-stream" \
    "$NEXUS_URL/events/stream" 2>>"$LOG_FILE")
}

# ── Mode: listen ────────────────────────────────────────────────────────────

_run_listen() {
  _ensure_fifo
  # Normalize seed values from plist (legacy "1"/"0"/"none") before the
  # bootstrap call, so the pre-bootstrap log line shows canonical shape.
  TTS_ENABLED="$(_normalize_bool "$TTS_ENABLED")"
  BANNER_ENABLED="$(_normalize_bool "$BANNER_ENABLED")"
  DUCKING_MODE="$(_normalize_ducking "$DUCKING_MODE")"
  _bootstrap_settings
  echo "[$(date)] nexus-notifier (listen) starting — url=$NEXUS_URL fifo=$NEXUS_NOTIFIER_FIFO tts_enabled=$TTS_ENABLED banner_enabled=$BANNER_ENABLED ducking_mode=$DUCKING_MODE" >> "$LOG_FILE"
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
#
# Two macOS-specific gotchas this drain handles:
#
# 1. macOS does NOT ship GNU `timeout`. It's part of coreutils, available via
#    `brew install coreutils` as `gtimeout`. We probe for either binary (or
#    fall through to running `say` without a timeout — `say` is well-behaved
#    so this is acceptable when the operator hasn't installed coreutils).
#
# 2. Bash's `while read; done < FIFO` sees EOF as soon as the last writer
#    closes its FD. The listener writes via `printf >> FIFO`, which opens-
#    writes-closes per dispatch — so without the `exec 3<>` trick the drain
#    loop exits after EVERY message, killing the worker and forcing a
#    KeepAlive respawn (4s of dead air per notification). The RDWR open
#    keeps a write-FD live in the drain process itself, so the read-side
#    never sees zero-writers-closed and the loop survives across messages.

# Resolve a usable timeout binary at startup. Falls back to `:` (no-op
# wrapper) when neither gtimeout nor timeout is available, so `say`
# still runs — just without the per-utterance cap.
_resolve_timeout_cmd() {
  if [ -x /opt/homebrew/bin/gtimeout ]; then
    echo "/opt/homebrew/bin/gtimeout 60"
  elif [ -x /usr/local/bin/gtimeout ]; then
    echo "/usr/local/bin/gtimeout 60"
  elif [ -x /usr/bin/timeout ]; then
    echo "/usr/bin/timeout 60"
  else
    echo ""
  fi
}

# Wrap the `say` invocation in apply/restore-ducking so the legacy say
# fallback honours DUCKING_MODE the same way the afplay path does. The
# drain worker is a different process from the listener, so it inherits
# DUCKING_MODE only via the plist EnvironmentVariables stanza — which is
# fine for `none|full` (no-op) and for `half|mute` (the per-utterance
# wrap save/sets/restores).
_drain_say_one() {
  local timeout_cmd="$1" line="$2"
  _apply_ducking
  if [ -n "$timeout_cmd" ]; then
    $timeout_cmd /usr/bin/say -- "$line" 2>>"$DRAIN_LOG" || \
      echo "[$(date)] say timed out or failed: $line" >> "$DRAIN_LOG"
  else
    /usr/bin/say -- "$line" 2>>"$DRAIN_LOG" || \
      echo "[$(date)] say failed: $line" >> "$DRAIN_LOG"
  fi
  _restore_ducking
}

_run_drain() {
  _ensure_fifo
  # Normalize ducking mode for the drain process. TTS_ENABLED is already
  # checked at the producer side (_dispatch_tts), so a "false" flag never
  # writes a line to the FIFO — the drain reads only allowed bodies.
  DUCKING_MODE="$(_normalize_ducking "$DUCKING_MODE")"
  local timeout_cmd
  timeout_cmd=$(_resolve_timeout_cmd)
  echo "[$(date)] nexus-tts-player (drain) starting — fifo=$NEXUS_NOTIFIER_FIFO ducking=$DUCKING_MODE ${timeout_cmd:+timeout=$timeout_cmd}${timeout_cmd:-(no timeout binary; running say uncapped)}" >> "$DRAIN_LOG"

  # Open the FIFO RDWR on FD 3 so we hold a write-end in this process.
  # That keeps the read side from seeing EOF when the listener closes its
  # transient writer between dispatches. Without this, the loop would
  # exit after every message and the launchctl respawn would gap audio.
  exec 3<> "$NEXUS_NOTIFIER_FIFO"

  while IFS= read -r line <&3; do
    [ -z "$line" ] && continue
    _drain_say_one "$timeout_cmd" "$line"
  done

  # Reaching here means the read FD itself errored — the FIFO was unlinked
  # or the kernel returned an unrecoverable read error. Exit so launchctl
  # KeepAlive relaunches us against a fresh FIFO.
  exec 3<&-
  echo "[$(date)] drain loop exited (read error or FIFO unlinked) — exiting for KeepAlive respawn" >> "$DRAIN_LOG"
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
