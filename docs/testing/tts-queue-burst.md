# TTS Playback Queue — Burst Reproducer

Manual verification procedure for the FIFO-based TTS playback queue introduced
in `add-tts-playback-queue`. This exercises the producer/consumer split — the
listener writes to a FIFO, a separate drain worker reads lines and synthesizes
each via `/usr/bin/say`. Five rapid notifications must play sequentially with
no audio overlap.

This document is **macOS only**. The bash unit tests at
`deploy/tests/nexus-notifier-modes.test.sh` cover the platform-agnostic mode
dispatcher on Linux CI.

Spec: `openspec/changes/add-tts-playback-queue/`

---

## 1. Pre-conditions

Both launchd agents must be loaded and running:

```bash
launchctl list | grep nexus
# Expected lines (PIDs will vary):
#   12345  0  com.nexus.notifier
#   12346  0  com.nexus.tts-player
```

If either is missing:

```bash
launchctl load ~/Library/LaunchAgents/com.nexus.notifier.plist
launchctl load ~/Library/LaunchAgents/com.nexus.tts-player.plist
```

Confirm the FIFO exists with mode `0600`:

```bash
ls -l "$HOME/Library/Application Support/nexus/tts-queue.fifo"
# prw-------  1 you  staff  0 ... tts-queue.fifo
```

---

## 2. Reproducer

Send five TTS notifications back-to-back. The `nx_notify` helper enqueues a
`tts` channel event on the agent, which the listener forwards to the FIFO:

```bash
source ~/.claude/scripts/lib/nx-send.sh
for i in 1 2 3 4 5; do
  nx_notify "Burst test number $i, listen for serial playback"
done
```

The shell returns immediately — all five messages are buffered through the
agent SSE stream → listener → FIFO before the first utterance even finishes
playing.

---

## 3. Expected behaviour

- Five distinct utterances play **sequentially**.
- Each utterance plays to completion before the next begins. No overlap.
- Total elapsed wall-clock ≈ 5× single-utterance length (typically 25–40 s
  for the messages above; the message body is intentionally long enough to
  make overlap audible if it occurred).

If you hear two utterances at once, the queue is **broken** — see § 5.

---

## 4. Verification

The drain worker logs one line per processed message:

```bash
tail -20 ~/Library/Logs/nexus-tts-player.log
```

Look for five entries with timestamps separated by the playback duration of
each utterance, **not** clustered within the same second:

```
[Sat Apr 26 14:01:02 PDT 2026] say completed: Burst test number 1, ...
[Sat Apr 26 14:01:08 PDT 2026] say completed: Burst test number 2, ...
[Sat Apr 26 14:01:14 PDT 2026] say completed: Burst test number 3, ...
[Sat Apr 26 14:01:20 PDT 2026] say completed: Burst test number 4, ...
[Sat Apr 26 14:01:26 PDT 2026] say completed: Burst test number 5, ...
```

If all five timestamps are within ~1 s of each other, the FIFO is being
bypassed — the old `say "$body" &` fork-and-forget pattern has crept back in.

---

## 5. Failure modes

If you observe overlap, check for concurrent `say` processes during the burst:

```bash
# In another terminal, while the burst is playing:
pgrep -fl say
# Expected during a healthy burst: exactly one `say` PID at a time.
# Broken: multiple `say` PIDs running concurrently.
```

Other failure signatures:

| Symptom | Likely cause |
| ------- | ------------ |
| Only utterance 1 plays, others silent | drain worker crashed; `launchctl list \| grep tts-player` |
| All 5 play simultaneously | Listener regressed to `say "$body" &` — check `_dispatch_tts` in `nexus-notifier.sh` |
| FIFO grows unbounded under load (`lsof -p <listener>`) | Drain worker stuck inside a single `say` call past the 60 s timeout — restart the player agent |
| Nothing plays | `NEXUS_ATTACH_SECRET` missing in `~/.env`; check `~/Library/Logs/nexus-notifier.log` |

---

## 6. Rollback

If the queue causes new issues that need to be unblocked before a fix lands,
revert to the pre-queue dispatch by replacing the FIFO write inside
`_dispatch_tts` (in `~/bin/nexus-notifier.sh`):

```bash
# BEFORE (queued, current):
_dispatch_tts() {
  local body="$1"
  printf '%s\n' "$body" >> "$NEXUS_NOTIFIER_FIFO" 2>>"$LOG_FILE"
}

# AFTER (pre-queue, fork-and-forget):
_dispatch_tts() {
  local body="$1"
  /usr/bin/say -- "$body" &
}
```

Then restart the listener and unload the player:

```bash
launchctl unload ~/Library/LaunchAgents/com.nexus.tts-player.plist
launchctl unload ~/Library/LaunchAgents/com.nexus.notifier.plist
launchctl load   ~/Library/LaunchAgents/com.nexus.notifier.plist
```

Audio overlap returns, but TTS keeps working. Track the rollback under a
follow-up beads issue so the queue is re-enabled deliberately.
