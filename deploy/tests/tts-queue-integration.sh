#!/usr/bin/env bash
# tts-queue-integration.sh — Mac-only integration test for the FIFO drain.
#
# Spawns `nexus-notifier.sh drain` with mocked paths (so the real
# ~/Library/... FIFO and logs are untouched), writes 3 lines, asserts the
# drain log shows 3 sequential entries with non-overlapping timestamps.
#
# Skipped on Linux CI — real `say` and `mkfifo` semantics are macOS-specific.
#
# Spec: openspec/changes/add-tts-playback-queue/

set -uo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "skipping on $(uname) — Mac-only integration test"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTIFIER="$SCRIPT_DIR/nexus-notifier.sh"

if [ ! -f "$NOTIFIER" ]; then
  echo "FAIL: $NOTIFIER not found" >&2
  exit 1
fi

# ── Mocked paths so we don't pollute ~/Library/Application Support/nexus ──
TMPDIR="$(mktemp -d -t nexus-test)"
export NEXUS_NOTIFIER_FIFO="$TMPDIR/tts-queue.fifo"
export NEXUS_NOTIFIER_LOG="$TMPDIR/notifier.log"
export NEXUS_TTS_PLAYER_LOG="$TMPDIR/tts-player.log"

DRAIN_PID=""

cleanup() {
  if [ -n "$DRAIN_PID" ] && kill -0 "$DRAIN_PID" 2>/dev/null; then
    kill "$DRAIN_PID" 2>/dev/null || true
    wait "$DRAIN_PID" 2>/dev/null || true
  fi
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

# ── Spawn drain mode ──────────────────────────────────────────────────────
# We don't want `say` actually speaking during a test, so override it via a
# temp PATH shim that just logs invocations and sleeps briefly to simulate
# playback duration (drives the timestamp-spacing assertion).
SHIM_DIR="$TMPDIR/bin"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/say" <<'SHIM'
#!/usr/bin/env bash
# Test shim: pretend to synthesize. Sleep long enough that overlap would be
# obvious in the timestamp diff (>= 1s).
echo "[$(date)] mock-say: $*" >> "${NEXUS_TTS_PLAYER_LOG:-/dev/null}"
sleep 1.2
SHIM
chmod +x "$SHIM_DIR/say"

# We can't easily PATH-override /usr/bin/say since the script hard-codes the
# absolute path. Symlink trick: build a private bin and prepend it AND copy
# `timeout` plus a wrapped notifier that rewrites the call.
SAY_WRAPPER="$TMPDIR/notifier-wrapped.sh"
sed 's|/usr/bin/timeout 60 /usr/bin/say|"'"$SHIM_DIR"'/say"|g' "$NOTIFIER" > "$SAY_WRAPPER"
chmod +x "$SAY_WRAPPER"

bash "$SAY_WRAPPER" drain &
DRAIN_PID=$!

# Give the drain loop a moment to open the FIFO for reading.
sleep 0.2

if ! kill -0 "$DRAIN_PID" 2>/dev/null; then
  echo "FAIL: drain process exited before we could write" >&2
  cat "$NEXUS_TTS_PLAYER_LOG" 2>/dev/null || true
  exit 1
fi

# ── Write 3 lines ─────────────────────────────────────────────────────────
printf 'one\ntwo\nthree\n' >> "$NEXUS_NOTIFIER_FIFO"

# ── Wait for 3 entries in the log (poll up to 15 s) ───────────────────────
deadline=$(($(date +%s) + 15))
while [ "$(date +%s)" -lt "$deadline" ]; do
  count=$(grep -c "mock-say:" "$NEXUS_TTS_PLAYER_LOG" 2>/dev/null || echo 0)
  if [ "$count" -ge 3 ]; then
    break
  fi
  sleep 0.3
done

count=$(grep -c "mock-say:" "$NEXUS_TTS_PLAYER_LOG" 2>/dev/null || echo 0)
if [ "$count" -lt 3 ]; then
  echo "FAIL: expected 3 mock-say entries, got $count" >&2
  cat "$NEXUS_TTS_PLAYER_LOG" 2>/dev/null || true
  exit 1
fi

# ── Assert non-overlapping timestamps (each ≥ 1s apart) ───────────────────
# `date` format from the script is locale-dependent; use file mtimes via
# `stat` instead — we appended one line per say call, so we can rely on
# the line-by-line ordering and the sleep 1.2 inside the shim. Cross-check
# by parsing the log timestamps to seconds-since-epoch.
ts_to_epoch() {
  # macOS `date -j -f` parses a formatted string back to epoch.
  date -j -f "%a %b %d %H:%M:%S %Z %Y" "$1" +%s 2>/dev/null
}

mapfile -t ts_lines < <(grep "mock-say:" "$NEXUS_TTS_PLAYER_LOG" \
  | sed -n 's/^\[\(.*\)\] mock-say:.*/\1/p')

if [ "${#ts_lines[@]}" -lt 3 ]; then
  echo "FAIL: could not parse 3 timestamps from log" >&2
  exit 1
fi

prev=0
for line in "${ts_lines[@]}"; do
  cur="$(ts_to_epoch "$line" || true)"
  if [ -z "$cur" ]; then
    echo "FAIL: could not parse timestamp '$line'" >&2
    exit 1
  fi
  if [ "$prev" -ne 0 ]; then
    diff=$((cur - prev))
    if [ "$diff" -lt 1 ]; then
      echo "FAIL: timestamps overlap (diff=${diff}s between '$line' and predecessor)" >&2
      exit 1
    fi
  fi
  prev="$cur"
done

echo "PASS: 3 sequential drain entries, non-overlapping (≥1s apart)"
