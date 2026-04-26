# Design Notes — add-tts-playback-queue

## Why a design.md
Three small choices in this change have significant downstream consequences (FIFO vs alternatives, ephemeral vs durable, single script vs split). Each is the kind of decision that becomes "obviously right" in retrospect but burns hours during implementation if rediscovered. Capturing them here makes the implementation pass mechanical.

## Why named-pipe (FIFO) over alternatives

### vs flock-based mutex
`flock -x lockfile bash -c 'say "$body"'` would serialize playback in three more lines of code. We rejected it because the producer (the SSE `_run_stream` loop) would block while a previous `say` finishes. A 30-second utterance + four queued events = the listener stalls for 2+ minutes, during which it stops reading SSE frames. Any peer-echo backlog or burst arriving in that window gets buffered in TCP and may be cut by Bun's idle timeout. The non-blocking dispatch is the load-bearing property here, not the serialization itself.

### vs file-based queue with watcher
Writing each notification to a numbered file in a queue dir, with `fswatch` or polling to drive the worker, would survive restarts. Rejected because: (a) we explicitly chose ephemeral semantics (see below), (b) `fswatch` adds a dependency and a coordination surface (file appearance vs file completeness), (c) the FIFO's kernel-level buffering already gives us "non-blocking producer + serial consumer" with zero additional state.

### Why FIFO is exactly right
- **Non-blocking write**: writes <PIPE_BUF (4KB) are atomic; macOS pipe buffer is ~64KB; one notification line is ~200 bytes. Producer never blocks for the burst sizes we see.
- **Blocking read**: consumer naturally blocks waiting for data, drains exactly one item at a time. No polling, no busy-wait, no scheduler tax.
- **Serial guarantee**: a single `read` from a single consumer reads a single line. Order is preserved.
- **Pure POSIX**: zero dependencies. No homebrew, no Swift, no Node — just `mkfifo` and `read`.

## Why ephemeral over disk-persisted

Notifications are *time-sensitive signals*, not durable events. "Build complete" five minutes ago, replayed at startup, is at best confusing and at worst actively misleading (the user already pivoted to the next thing). The cost of replaying a stale notification > the cost of dropping it.

The few-second loss window during a service restart is acceptable because:
- Restarts are rare (only on script changes)
- The producer (Linux agent SSE event) keeps a record in the `notifications` DB table — a missed playback is fully recoverable from logs if the user cares
- The launchctl `KeepAlive` semantics make crash-restart fast (typically <2s), so the loss window is shorter than the human ear takes to register the silence

## Why same script + separate launchctl

### Same script
Two .sh files would fragment the secret-loading logic, the log-path resolution, the FIFO path. Drift between them is inevitable — one gets a fix, the other doesn't, and overlap-with-amnesia returns. A single file with a 3-line mode dispatcher at the top eliminates the drift surface entirely.

### Separate launchctl
Three concrete benefits:
1. **Independent respawn**. If `say` ever wedges (audio device contention, OS update mid-session), only the player crashes. The listener stays attached to SSE, no events lost.
2. **Resource isolation**. The player's process tree is one bash + one say at a time. The listener's process tree is one bash + one curl. The kernel scheduler treats them independently; macOS's per-PID resource accounting is cleaner.
3. **Log separation**. `~/Library/Logs/nexus-notifier.log` (listener) and `~/Library/Logs/nexus-tts-player.log` (player) tail independently. Debugging "did the listener receive it" is one tail; "did the player play it" is another.

The cost (one extra plist file) is trivial relative to the operational clarity.

## Why mode is positional, not a flag

`nexus-notifier.sh listen` parses with one-liner `case "${1:-listen}" in`. `--mode listen` would force a getopts loop or argparse-equivalent — overkill for two values. The trade-off (positional is less self-documenting) is mitigated by the case-statement reading like a switch table.

## Why the FIFO path lives under `~/Library/Application Support/nexus/`

The cache for emoji icons (`tts-cache/`) and the bundle manager's icon cache already live under `~/Library/Application Support/nexus/`. Putting the FIFO there keeps the runtime state directory consistent and makes "wipe nexus state" a `rm -rf ~/Library/Application Support/nexus` away.

`/tmp` was considered and rejected: macOS clears `/tmp` at boot but the FIFO surviving a soft restart is sometimes useful for diagnosis. `~/.config/nexus/` was considered and rejected: that directory is for *config* (agents.toml, secrets.env), not runtime state.

## Why a 60-second timeout on `say`

`say` reads the body and synthesizes via the system TTS pipeline. For typical notifications (≤200 chars at default speech rate ≈180 WPM) playback runs ~5–15 seconds. A 60-second cap is well above the natural ceiling but catches the rare cases:
- Body contains a million-character string (some hook event firing pathologically)
- Audio device wedged mid-playback waiting for a hardware response
- macOS speech daemon (`speechsynthesisd`) crashes mid-utterance and `say` hangs waiting

A timeout that's too tight would clip legitimate long messages; one that's too loose would let the queue stall indefinitely. 60s is the smallest power-of-five-sounding number that's still "obviously fine for any normal use."

## What's deferred

| Deferred | Reason |
|----------|--------|
| Bounded queue with overflow policy | Homelab single-user load doesn't warrant it. Add only if a real burst causes hours-long lag. |
| Per-notification playback timing recorded for analytics | Lands in `add-elevenlabs-usage` along with quota polls — both are "signals from the playback worker." |
| Priority levels (P0 notifications jump the queue) | We don't have a priority field in the channel payload yet; introducing it just for queue-jumping is over-engineered. |
| Linux-side serialization | Linux agent has no `say`; all audio is Mac-side. The producer is already single-threaded so there's no equivalent overlap risk. |
| Dropping items older than N minutes | Easy to add as a player-side filter without changing the producer contract. Defer until we observe stale playback in practice. |
