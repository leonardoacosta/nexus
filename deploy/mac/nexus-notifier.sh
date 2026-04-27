#!/usr/bin/env bash
# nexus-notifier.sh — Mac-side audio dispatch for the
# `restore-tts-mac-audio-dispatch` architecture.
#
# Subscribes to ${NEXUS_URL}/events/stream as an SSE client, reads
# NotificationFired frames, and on each frame:
#
#   1. Pulls `payload.audioBase64` (mp3 bytes from the agent's ElevenLabs
#      synthesis), base64-decodes it to /tmp/nexus-notifier-<uuid>.mp3.
#   2. Invokes /usr/bin/afplay on the temp file, backgrounded so the SSE
#      read loop stays responsive.
#   3. Schedules a best-effort cleanup of the temp file after afplay exits.
#
# When `audioBase64` is absent (signal-only — no key in DB or env, or the
# upstream HTTP call failed), the listener falls back to /usr/bin/say with
# the body text. This guarantees Leo still hears every notification even
# when ElevenLabs is offline.
#
# Reconnect strategy: a 5-second sleep on stream drop, indefinite retry.
# launchctl's KeepAlive handles full process death (audio device wedge,
# kernel-level read errors, etc.).
#
# Wave 3 (add-notification-control-dashboard): on startup the listener
# pulls /notifications/settings from the agent and caches `tts_enabled`,
# `banner_enabled`, and `ducking_mode` into the shell vars below. SSE
# `SettingsChanged` frames update the same vars in place — no restart.
# Suppressed events are mirrored into SUPPRESS_LOG so the dashboard table
# can cross-reference "listener saw it but suppressed".
#
# Spec: openspec/changes/restore-tts-mac-audio-dispatch/
#       openspec/changes/add-notification-control-dashboard/

set -uo pipefail

NEXUS_URL="${NEXUS_URL:-http://homelab:7400}"
LOG_FILE="${NEXUS_NOTIFIER_LOG:-$HOME/Library/Logs/nexus-notifier.log}"
# Suppression cross-reference log — task 4.6 of the dashboard spec routes
# every "TTS-suppressed" / "banner-suppressed" line into the StandardOut
# stream so `tail -f ~/Library/Logs/nexus-notifier.out.log` shows them
# alongside launchd output.
SUPPRESS_LOG="${NEXUS_NOTIFIER_SUPPRESS_LOG:-$HOME/Library/Logs/nexus-notifier.out.log}"

# Cached settings — seeded from plist EnvironmentVariables, then overwritten
# by the GET /notifications/settings call in _bootstrap_settings. SSE
# SettingsChanged frames mutate these in place (see _process_settings_changed).
#
# Canonical values are "true" / "false" (matching the JSON wire format).
# Legacy plist values "1" / "0" are normalized on read.
TTS_ENABLED="${TTS_ENABLED:-true}"
BANNER_ENABLED="${BANNER_ENABLED:-true}"
DUCKING_MODE="${DUCKING_MODE:-full}"

# Volume-restoration state used by _apply_ducking / trap-on-completion. The
# saved values are populated only when DUCKING_MODE != full; restore is a
# no-op when nothing was saved.
_SAVED_VOLUME=""
_SAVED_MUTED=""

_log() {
  printf '[%s] %s\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
}

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
# The plist historically used "1"/"0" while the new API returns "true"/"false".
# Normalize to canonical "true"/"false" / "full"|"half"|"mute" so downstream
# guards have one shape to compare against.
_normalize_bool() {
  case "$1" in
    1|true|TRUE|True|yes|on)  printf 'true' ;;
    0|false|FALSE|False|no|off) printf 'false' ;;
    *) printf 'true' ;;  # default-true on garbage input — least surprise
  esac
}

_normalize_ducking() {
  case "$1" in
    full|half|mute) printf '%s' "$1" ;;
    none|"")        printf 'full' ;;  # legacy plist value -> full (no-op)
    *)              printf 'full' ;;
  esac
}

# ── Settings bootstrap (task 4.1) ──────────────────────────────────────────
# GET /notifications/settings on startup. Cache into TTS_ENABLED /
# BANNER_ENABLED / DUCKING_MODE. Tolerate 404 (first-install before the
# dashboard migration has run) and any HTTP failure by falling back to the
# spec defaults: tts=true, banner=true, ducking=full.
_bootstrap_settings() {
  local response http_code body
  response="$(/usr/bin/curl -sS -m 5 -w '\n%{http_code}' \
    -H "x-nexus-secret: $NEXUS_ATTACH_SECRET" \
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
    _log "settings bootstrapped tts=$TTS_ENABLED banner=$BANNER_ENABLED ducking=$DUCKING_MODE"
  else
    # 404 (table not migrated yet) or any non-200 — fall back to spec defaults.
    TTS_ENABLED="true"
    BANNER_ENABLED="true"
    DUCKING_MODE="full"
    _log "settings GET failed (http=$http_code); using defaults tts=true banner=true ducking=full"
  fi
}

# ── SSE SettingsChanged handler (task 4.2) ─────────────────────────────────
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
  _log "SettingsChanged applied tts=$TTS_ENABLED banner=$BANNER_ENABLED ducking=$DUCKING_MODE"
}

# ── Audio ducking (task 4.5) ───────────────────────────────────────────────
# Apply DUCKING_MODE *before* afplay; populate _SAVED_* so _restore_ducking
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
      _log "ducking half — saved_volume=${_SAVED_VOLUME:-?} -> 25"
      ;;
    mute)
      _SAVED_MUTED="$(/usr/bin/osascript -e 'output muted of (get volume settings)' 2>/dev/null || printf '')"
      /usr/bin/osascript -e "set volume with output muted" >/dev/null 2>&1 || true
      _log "ducking mute — saved_muted=${_SAVED_MUTED:-?} -> true"
      ;;
  esac
}

_restore_ducking() {
  if [ -n "$_SAVED_VOLUME" ]; then
    /usr/bin/osascript -e "set volume output volume ${_SAVED_VOLUME}" >/dev/null 2>&1 || true
    _log "ducking restored — volume=$_SAVED_VOLUME"
    _SAVED_VOLUME=""
  fi
  if [ "$_SAVED_MUTED" = "false" ]; then
    /usr/bin/osascript -e "set volume without output muted" >/dev/null 2>&1 || true
    _log "ducking restored — unmuted"
    _SAVED_MUTED=""
  elif [ "$_SAVED_MUTED" = "true" ]; then
    # Was already muted before we touched it — leave it muted.
    _SAVED_MUTED=""
  fi
}

# ── Banner dispatch (task 4.4) ─────────────────────────────────────────────
# Mirrors _dispatch_audio in shape: short-circuit on BANNER_ENABLED=false,
# otherwise fire `osascript -e 'display notification ...'`. Title/body are
# escaped via printf %q-style quoting (we use a here-doc into osascript so
# embedded quotes can't break out).
_dispatch_banner() {
  local title="$1" body="$2"

  if [ "$BANNER_ENABLED" = "false" ]; then
    _log_suppressed "banner suppressed (banner_enabled=false) title=\"$title\""
    return 0
  fi

  # AppleScript needs double-quotes escaped. Use printf to emit the script
  # so embedded special chars in $title / $body survive intact.
  /usr/bin/osascript <<APPLESCRIPT 2>>"$LOG_FILE" &
display notification "$(printf '%s' "$body" | /usr/bin/sed 's/"/\\"/g')" with title "$(printf '%s' "$title" | /usr/bin/sed 's/"/\\"/g')"
APPLESCRIPT
  _log "banner dispatched title=\"$title\""
}

# ── Secret loader ──────────────────────────────────────────────────────────
# Sources $HOME/.env (with `set -a` so any variables defined there land in
# the environment) when NEXUS_ATTACH_SECRET isn't already set. Fail-closed.
_load_secret() {
  if [ -z "${NEXUS_ATTACH_SECRET:-}" ] && [ -f "$HOME/.env" ]; then
    # shellcheck disable=SC1091
    set -a; . "$HOME/.env"; set +a
  fi
  if [ -z "${NEXUS_ATTACH_SECRET:-}" ]; then
    _log "NEXUS_ATTACH_SECRET not set — cannot authenticate to $NEXUS_URL"
    exit 1
  fi
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

# ── Audio dispatch (the work) ──────────────────────────────────────────────
#
# `audio_b64` is the mp3 payload as decoded by jq -r from payload.audioBase64.
# The empty string means signal-only — fall back to `say "$body"`.
_dispatch_audio() {
  local audio_b64="$1" body="$2"

  # TTS suppression (task 4.3). Accept the canonical "false" plus the legacy
  # plist value "0" so an old plist doesn't suddenly start playing audio.
  if [ "${TTS_ENABLED}" = "false" ] || [ "${TTS_ENABLED}" = "0" ]; then
    _log_suppressed "tts suppressed (tts_enabled=$TTS_ENABLED)"
    return 0
  fi

  # Ducking applies regardless of base64-vs-say path. Save state up-front;
  # the cleanup subshell restores after afplay/say exits.
  _apply_ducking

  if [ -n "$audio_b64" ]; then
    local uuid tmp
    uuid="$(_gen_uuid)"
    tmp="/tmp/nexus-notifier-${uuid}.mp3"

    # macOS base64 reads stdin; -d decodes, -o writes to a path. We pipe
    # via printf to avoid a temp .b64 file (and to side-step shells that
    # mangle large args).
    if ! printf '%s' "$audio_b64" | /usr/bin/base64 -d -o "$tmp" 2>>"$LOG_FILE"; then
      _log "base64 decode failed; falling back to say"
      /usr/bin/say -- "$body" 2>>"$LOG_FILE" &
      local saypid=$!
      ( wait "$saypid" 2>/dev/null; _restore_ducking ) &
      return 0
    fi

    # Background afplay so the SSE loop never blocks on playback. Trail
    # the cleanup with a subshell that waits for afplay's PID, then unlinks
    # the temp file *and* restores the pre-ducking volume/mute state.
    /usr/bin/afplay "$tmp" >>"$LOG_FILE" 2>&1 &
    local afpid=$!
    ( wait "$afpid" 2>/dev/null; /bin/rm -f "$tmp" 2>/dev/null; _restore_ducking ) &
    _log "afplay scheduled pid=$afpid path=$tmp ducking=$DUCKING_MODE"
  else
    # Signal-only frame — agent had no key or the upstream call failed.
    _log "no audioBase64; falling back to say"
    /usr/bin/say -- "$body" 2>>"$LOG_FILE" &
    local saypid=$!
    ( wait "$saypid" 2>/dev/null; _restore_ducking ) &
  fi
}

# ── SSE frame handler ──────────────────────────────────────────────────────
_process_event() {
  local data="$1"
  local channel title body audio_b64
  channel=$(printf '%s' "$data" | /usr/bin/jq -r '.payload.channel // empty' 2>/dev/null)
  title=$(printf '%s' "$data" | /usr/bin/jq -r '.payload.title // empty' 2>/dev/null)
  body=$(printf '%s' "$data" | /usr/bin/jq -r '.payload.body // .payload.message // empty' 2>/dev/null)
  audio_b64=$(printf '%s' "$data" | /usr/bin/jq -r '.payload.audioBase64 // empty' 2>/dev/null)

  case "$channel" in
    tts|*tts*)
      _dispatch_audio "$audio_b64" "$body"
      ;;
    desktop)
      # Banner channel — fire osascript display notification. Banner spec
      # is task 4.4 of the dashboard wave; suppression is gated inside
      # _dispatch_banner so the call site stays trivial.
      _dispatch_banner "${title:-Nexus}" "$body"
      ;;
    *)
      # Other channels (slack) handled by their own listeners. Audio +
      # banner dispatch ignore them.
      :
      ;;
  esac
}

# ── SSE read loop ──────────────────────────────────────────────────────────
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
            _process_event "${line#data: }"
            ;;
          SettingsChanged)
            # Task 4.2 — apply settings update without restarting the
            # listener. The cached vars TTS_ENABLED / BANNER_ENABLED /
            # DUCKING_MODE are mutated in-place inside this process.
            _process_settings_changed "${line#data: }"
            ;;
        esac
        event_name=""
        ;;
      "")
        event_name=""
        ;;
    esac
  # --max-time 1800 forces a reconnect every 30 minutes so a half-open
  # TCP socket (Mac wifi sleep, Tailscale wake-from-sleep, NAT timeout)
  # can never wedge the listener indefinitely.
  # --keepalive-time 60 lets the kernel ETIMEDOUT us promptly when the
  # peer disappears.
  done < <(/usr/bin/curl -sN --no-buffer \
    --max-time 1800 \
    --keepalive-time 60 \
    -H "Accept: text/event-stream" \
    -H "x-nexus-secret: $NEXUS_ATTACH_SECRET" \
    "$NEXUS_URL/events/stream" 2>>"$LOG_FILE")
}

# ── Main ───────────────────────────────────────────────────────────────────
_main() {
  _load_secret
  # Normalize seed values from plist (legacy "1"/"0"/"none") before the
  # bootstrap call, so the pre-bootstrap log line shows canonical shape.
  TTS_ENABLED="$(_normalize_bool "$TTS_ENABLED")"
  BANNER_ENABLED="$(_normalize_bool "$BANNER_ENABLED")"
  DUCKING_MODE="$(_normalize_ducking "$DUCKING_MODE")"
  _bootstrap_settings
  _log "nexus-notifier (mac, audio-dispatch) starting — url=$NEXUS_URL tts_enabled=$TTS_ENABLED banner_enabled=$BANNER_ENABLED ducking_mode=$DUCKING_MODE"
  while true; do
    _run_stream
    _log "stream disconnected; reconnecting in 5s"
    sleep 5
  done
}

_main "$@"
