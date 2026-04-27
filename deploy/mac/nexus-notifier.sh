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
# Wave 2 reservation: TTS_ENABLED / BANNER_ENABLED / DUCKING_MODE shell
# vars are read but not yet enforced — the dashboard spec adds suppression
# UI in the next wave. Today the script honors them only as no-op exports
# so the launchd plist can declare them without blowing up.
#
# Spec: openspec/changes/restore-tts-mac-audio-dispatch/

set -uo pipefail

NEXUS_URL="${NEXUS_URL:-http://homelab:7400}"
LOG_FILE="${NEXUS_NOTIFIER_LOG:-$HOME/Library/Logs/nexus-notifier.log}"

# Wave 2 placeholders — declared so plist EnvironmentVariables can set them
# without `set -u` aborting on unset reads. Suppression logic itself ships
# with the dashboard spec.
TTS_ENABLED="${TTS_ENABLED:-1}"
BANNER_ENABLED="${BANNER_ENABLED:-1}"
DUCKING_MODE="${DUCKING_MODE:-none}"

_log() {
  printf '[%s] %s\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
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

  # TTS_ENABLED=0 short-circuits both paths. The banner side is the
  # dashboard spec's responsibility — left untouched here.
  if [ "${TTS_ENABLED}" = "0" ]; then
    _log "tts suppressed (TTS_ENABLED=0)"
    return 0
  fi

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
      return 0
    fi

    # Background afplay so the SSE loop never blocks on playback. Trail
    # the cleanup with a subshell that waits for afplay's PID, then unlinks.
    /usr/bin/afplay "$tmp" >>"$LOG_FILE" 2>&1 &
    local afpid=$!
    ( wait "$afpid" 2>/dev/null; /bin/rm -f "$tmp" 2>/dev/null ) &
    _log "afplay scheduled pid=$afpid path=$tmp"
  else
    # Signal-only frame — agent had no key or the upstream call failed.
    _log "no audioBase64; falling back to say"
    /usr/bin/say -- "$body" 2>>"$LOG_FILE" &
  fi
}

# ── SSE frame handler ──────────────────────────────────────────────────────
_process_event() {
  local data="$1"
  local channel body audio_b64
  channel=$(printf '%s' "$data" | /usr/bin/jq -r '.payload.channel // empty' 2>/dev/null)
  body=$(printf '%s' "$data" | /usr/bin/jq -r '.payload.body // .payload.message // empty' 2>/dev/null)
  audio_b64=$(printf '%s' "$data" | /usr/bin/jq -r '.payload.audioBase64 // empty' 2>/dev/null)

  case "$channel" in
    tts|*tts*)
      _dispatch_audio "$audio_b64" "$body"
      ;;
    *)
      # Other channels (desktop, slack) handled by other listeners or by
      # the dashboard banner pipeline. Audio dispatch ignores them.
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
        if [ "$event_name" = "NotificationFired" ]; then
          _process_event "${line#data: }"
        fi
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
  _log "nexus-notifier (mac, audio-dispatch) starting — url=$NEXUS_URL tts_enabled=$TTS_ENABLED banner_enabled=$BANNER_ENABLED ducking_mode=$DUCKING_MODE"
  while true; do
    _run_stream
    _log "stream disconnected; reconnecting in 5s"
    sleep 5
  done
}

_main "$@"
