# Design: Consolidate Mac TTS Listener

## Background

Two SSE listeners are currently subscribed to `http://localhost:7400/events/stream`:

| Listener | Launchd label | PID | Engine | Repo-tracked |
| --- | --- | --- | --- | --- |
| Canonical bash | `com.nexus.notifier` + `com.nexus.tts-player` | 71202 + 71309 | afplay (ElevenLabs mp3) + FIFO say fallback | YES (`deploy/`) |
| Duplicate Bun/TS | `com.leonardoacosta.nexus-listener` | 755 | `/usr/bin/say` only | NO (`~/.local/share/`) |

Both process the same `NotificationFired` events independently — dedup is per-listener (30-second window keyed on payload id), so cross-listener overlap is not caught. Every TTS notification produces two audio renderings: ElevenLabs voice from afplay, macOS `say` voice from the Bun listener, same second, same body.

The Bun listener was authored on May 2 as a defensive rewrite of the bash listener's listen mode, motivated by a theoretical bash 3.2 process-substitution stall bug. The decommissioning step was skipped, leaving both listeners running. The double-audio remained masked for ~3 weeks because the bash listener's `NEXUS_URL` was hardcoded to `http://homelab:7400` (unreachable from the Mac over Tailscale during this window). Commit `90a5833` fixed the URL to `localhost`, instantly unmasking the duplication.

## Goals

1. End the active double-audio bug on macbook.
2. Port the Bun listener's one valuable feature (banner-click cancels current TTS) into the bash side before decommissioning, so there's zero UX regression.
3. Prevent future regression — hard-delete artifacts, add memory note.

## Non-Goals

- **Rewriting the bash SSE consumer in another language.** The bash 3.2 stall mitigation (`curl --max-time 1800 --keepalive-time 60` forced reconnect) has held for 2+ weeks of production use. A Bun/Node rewrite is premature; revisit only if the stall pattern fires in observed logs.
- **Cross-platform support.** Homelab is headless; no listener runs there. Linux/Windows support is out of scope. The bash notifier remains Mac-only.
- **In-process audio queue.** The FIFO + drain split is a feature (crash isolation between SSE listener and audio device), not a bug worth replacing.
- **Banner-action APIs beyond cancel.** The Bun listener only ever used `-execute` for cancellation; a richer banner-action surface (snooze, reply, etc.) is a follow-on if needed.

## Pid-File IPC Design

### Path
`~/Library/Application Support/nexus/current-utterance.pid`

Same directory as `tts-queue.fifo` — keeps nexus runtime state co-located, survives launchd respawn cleanly, and isolated from `/tmp` clearing.

### Lifecycle

| Event | Writer | Action |
| --- | --- | --- |
| `_dispatch_audio` spawns afplay | bash listener process | `printf '%s' "$afpid" > "$pid_file.tmp" && mv "$pid_file.tmp" "$pid_file"` immediately after `afplay … &` |
| afplay exits (any reason) | cleanup subshell in `_dispatch_audio` | `: > "$pid_file"` (truncate) |
| `_drain_say_one` spawns say | drain worker process | atomic write of `$!` after launching say |
| say exits (natural / timeout / kill -TERM) | `_drain_say_one` | truncate pid file before reading next FIFO line |

### Reader (listener-side)

In `_dispatch_banner`, before composing terminal-notifier args:

```bash
local cancel_args=()
if [ -s "$pid_file" ]; then
  local pid
  pid=$(cat "$pid_file" 2>/dev/null || printf '')
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    cancel_args=(-execute "/bin/kill -TERM $pid")
  fi
done
```

Then `"$tn" "${args[@]}" "${cancel_args[@]}"`.

### Atomicity argument

A `printf > x.tmp && mv x.tmp x` sequence guarantees the reader sees either the full prior pid or the full new pid, never a half-written value. Pid values are short (≤7 digits on macOS) so even a non-atomic write would rarely tear, but `mv` on the same filesystem is rename(2) which is atomic per POSIX — using it costs nothing.

### Stale pid tolerance

`kill -TERM` on a dead pid returns non-zero with `No such process`. The shell exits the `-execute` command non-zero, but terminal-notifier ignores the exit code (the click action is fire-and-forget). The pid file is left non-empty until the next dispatch overwrites it — this is acceptable because the next audio start will replace the value before any subsequent click reads it.

Edge case: pid recycling. If pid 12345 dies and macOS reassigns 12345 to a different process between the listener's read and the user's click, the click would kill the wrong process. Mitigation: macOS pid recycling is bounded by PID_MAX (~99999 on macOS 26), reassignment within a 1-3 second click window is rare in practice, and the worst case is killing an unrelated user process owned by the same uid. Acceptable risk — same exposure as any other use of pid-based IPC.

## Bash 3.2 Stall Mitigation (Non-Goal Justification)

The Bun listener's header claims `done < <(curl …)` has "a well-known stall on macOS-bundled bash 3.2 (process-substitution + child FD inheritance race that wedges the read loop after the first dispatched event)." The bash listener's stall site is `deploy/nexus-notifier.sh:524`. Observed behavior 2026-05-16 09:34–09:43: the bash listener processed at least 7 TTS notifications without stalling, including bursts and dedup cases. The mitigation in place:

- `curl --max-time 1800` — forced reconnect every 30 minutes
- `curl --keepalive-time 60` — TCP keepalive probes every 60s detect dead peers
- Outer reconnect loop: `while true; do _run_stream; sleep 5; done`

If the stall pattern ever fires, the 30-minute max-time bounds the outage. A rewrite would replace simplicity (a few hundred lines of bash) with a Bun process that's harder to debug at 3am. Not worth it.

## Nuke Sequence

```bash
# 1. Stop the launchd agent
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.leonardoacosta.nexus-listener.plist

# 2. Remove all artifacts
rm ~/Library/LaunchAgents/com.leonardoacosta.nexus-listener.plist
rm ~/.local/share/nexus-listener.ts
rm ~/.local/state/nexus-listener.log
rm ~/.local/state/nexus-listener.stdout.log
rm ~/.local/state/nexus-listener.stderr.log

# 3. Verify no live refs
rg -l "nexus-listener" ~/.claude/ ~/dev/nx/ ~/bin/ ~/.local/ 2>/dev/null

# 4. Memory note
bd remember "Mac TTS: com.nexus.notifier (bash) is canonical. com.leonardoacosta.nexus-listener (Bun) was decommissioned 2026-05-16 — caused double-audio because both subscribed to the same SSE stream. Banner-click cancel was ported into bash via current-utterance.pid IPC; do not reinstall Bun listener."

# 5. Single-audio verification
source ~/.claude/scripts/lib/nx-send.sh
nx_notify "Single audio verification ping after Bun listener decommissioning"
# Confirm: exactly ONE voice plays (ElevenLabs from afplay).
```

## Alternatives Considered

| Alternative | Why rejected |
| --- | --- |
| **Keep both, disable Bun's audio path** | Still consumes SSE bandwidth, still respawns on KeepAlive, still surfaces in `launchctl list` as drift. Half-measures invite resurrection. |
| **Use control FIFO (listener → drain CANCEL msg)** instead of pid-file | Adds a new IPC channel, requires drain to multiplex read between data and control. PID-file is simpler and survives drain respawn cleanly. |
| **Move audio dispatch back into listener (Bun-style in-process queue)** | Loses crash isolation between SSE listener and audio device. A wedged audio device would freeze the SSE loop. The current split is a deliberate reliability feature from `2026-04-26-add-tts-playback-queue`. |
| **Soft-retire Bun listener (rename .disabled)** | Reversible but pollutes `~/.local/share` with dead code. Future agents may revive it. Hard delete + memory note is the durable answer per Leo's call. |

## Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Pid-file write races between afplay and drain say (both running due to misconfiguration) | Low — only one path fires per event in current architecture | Atomic `mv` makes the last writer win cleanly; no corruption possible |
| Pid recycling kills wrong process | Very low (3-second window, same-uid only) | Document risk; acceptable for click-to-cancel UX |
| Operator forgets to run `launchctl bootout` and only `rm`s the plist | Medium | Tasks.md sequences bootout BEFORE rm; verification step checks `launchctl list` |
| Memory note isn't loaded by a future session | Medium-low | `bd remember` writes to Dolt-backed memory which auto-loads on session start |

## Verification

Single-audio confirmation post-nuke: fire `nx_notify "test ping"`, observe exactly one voice. Compare `~/Library/Logs/nexus-notifier.log` showing the event vs absence of any entry in (deleted) `~/.local/state/nexus-listener.log`. `launchctl list | grep nexus` shows only `com.nexus.agent`, `com.nexus.notifier`, `com.nexus.tts-player` (and `com.apple.nexusd` from macOS itself — not ours).

Cancel verification: fire a long-body notification (`nx_notify "$(seq 1 50 | xargs)"`), click banner mid-utterance, confirm audio stops within ~100ms and pid file is empty.
