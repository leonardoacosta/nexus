# Proposal: Serial TTS Playback Queue for Mac Notifier

## Change ID
`add-tts-playback-queue`

## Summary
Replace the current fire-and-forget `say "$body" &` dispatch in `~/bin/nexus-notifier.sh` with a named-pipe (FIFO) producer/consumer queue and a dedicated launchctl-managed drain worker, so concurrent notifications play sequentially instead of overlapping into garbled audio.

## Context
- Extends: `~/bin/nexus-notifier.sh` (currently backgrounds every `say` invocation, causing overlap)
- Extends: `deploy/nexus-notifier.sh` + `deploy/com.nexus.notifier.plist` (in-repo copies tracked since `bb7abf3`)
- New: `deploy/com.nexus.tts-player.plist` (separate launchctl agent for the drain worker)
- Related: bug `nx-vq4rm` (the symptom this change fixes)
- Related: archive `2026-04-20-fix-tts-announce-project-prefix` (last TTS-side change to the dispatch path)
- Related: in-flight `restore-tts-mac-audio-dispatch` (delivery channel; this queue sits downstream of it)
- Prior art: Nova daemon TTS queue at `~/dev/nv/packages/daemon/src/features/tts/`

## Motivation
Today's pain (observed 2026-04-26): when a multi-agent batch dispatches several notifications within a few seconds, `~/bin/nexus-notifier.sh _dispatch_tts` runs `/usr/bin/say -- "$body" &` for each — the trailing `&` detaches every invocation, so N notifications produce N concurrent `say` processes playing simultaneously into the same audio device. The user hears overlapping voices and loses message content.

Beyond the audible-bug fix, this change also creates the structural separation needed for the next two ElevenLabs slices (`add-elevenlabs-usage`, `add-elevenlabs-dashboard`) to attribute playback events to specific notifications — a single drain worker is the natural place to record "notification X started playing at T, finished at T+Δ" without the SSE listener having to instrument every dispatch path.

## Requirements

### Requirement: Notifications MUST play sequentially with no audible overlap
When the producer (the SSE event handler) dispatches multiple TTS notifications within a window shorter than total playback time, the listener MUST hear each utterance fully before the next begins. The producer MUST NOT block the SSE-read loop while playback is in progress.

#### Scenario: Burst of three short notifications
Given the notifier is running with the FIFO queue active
When three nx_notify calls fire within 200ms
Then three sequential utterances play with no overlap, in the order received

#### Scenario: Long playback during incoming burst
Given a 30-second-long playback is in progress
When five additional nx_notify calls arrive while it plays
Then the listener processes all five SSE events without stalling, and the five new utterances queue up to play after the current one finishes

### Requirement: Queue mechanism SHALL be a named-pipe (FIFO) with a single drain worker
The notifier MUST create a named pipe at a stable path (`$NEXUS_NOTIFIER_FIFO`, default `~/Library/Application Support/nexus/tts-queue.fifo`) on startup if it does not exist. The producer (SSE handler) MUST `printf '%s\n' "$body" >> $FIFO`. A separate drain worker process MUST `while IFS= read -r line; do /usr/bin/say -- "$line"; done < $FIFO`.

#### Scenario: FIFO created at startup
Given the FIFO does not exist
When the notifier listener starts
Then `mkfifo` is called, the FIFO file is present at the configured path, and its mode is `0600`

#### Scenario: Producer write does not block on slow consumer
Given the drain worker is mid-playback (held inside a `say` call)
When the producer writes a new line to the FIFO
Then the write returns immediately (kernel buffers the line) and the SSE loop continues

### Requirement: Drain worker SHALL run as its own launchctl agent
A new plist `com.nexus.tts-player.plist` MUST register a launchctl agent that invokes `~/bin/nexus-notifier.sh drain`. The existing `com.nexus.notifier.plist` MUST be updated to invoke `~/bin/nexus-notifier.sh listen` (explicit mode argument). Both plists MUST set `KeepAlive` so a wedged `say` (audio device contention, rare) crashes only the player and is automatically respawned without affecting the listener.

#### Scenario: Player crash does not affect listener
Given both agents are running
When the tts-player process is killed (e.g., `kill -9 $TTS_PLAYER_PID`)
Then the listener continues to receive SSE events without disconnect, the player is respawned by launchctl within 5 seconds, and queued items written between crash and respawn are drained on respawn

#### Scenario: Listener crash does not affect player
Given both agents are running and a long playback is active
When the listener process is killed
Then the player finishes the current utterance and any items already queued in the FIFO before exiting (FIFO close on producer side does NOT terminate the consumer until pending bytes drain)

### Requirement: Same-script-different-mode invocation SHALL keep the codebase as a single file
`~/bin/nexus-notifier.sh` MUST accept a single positional argument `listen | drain`. The `listen` mode runs the SSE subscription + producer logic (current behavior minus the inline `say` call). The `drain` mode runs only the FIFO-read-and-play loop. Helper functions (FIFO path resolution, log file path, secret loading) MUST be defined once at the top of the file and used by both modes. Default mode (no argument) MUST be `listen` for backwards compatibility with the existing plist if it has not been updated.

#### Scenario: Default mode is listen
Given `~/bin/nexus-notifier.sh` is invoked with no arguments
When it executes
Then it runs the listen loop (SSE subscription + producer) and exits with the same semantics as today

#### Scenario: Drain mode invocation
Given `~/bin/nexus-notifier.sh drain` is invoked
When it executes
Then it loops `read line < FIFO` → `say "$line"` indefinitely, with no SSE subscription and no banner dispatch

### Requirement: Restart semantics SHALL be ephemeral
On listener or player startup, any pre-existing FIFO MUST be deleted and recreated fresh. Pending items in a stale FIFO are dropped. This intentionally trades durability for simplicity — notifications are time-sensitive and replaying a 5-minute-old utterance after a service crash is more confusing than useful.

#### Scenario: Stale FIFO purged at startup
Given a FIFO exists from a previous run with N pending items
When either the listener or the player starts
Then the existing FIFO is unlinked, a new empty FIFO is created, and the previous N items are not played

### Requirement: Banner dispatch SHALL remain unaffected
The change applies only to the TTS playback path. The banner-dispatch path (`_dispatch_banner` calling terminal-notifier with `-sender <bundle-id>`) MUST continue to fire concurrently with TTS — banners do not collide with audio output.

#### Scenario: Banner fires immediately even when audio is queued
Given five notifications are queued in the FIFO and playback is active on item 1
When a sixth notification arrives with channel `tts`
Then the banner for the sixth notification appears immediately (terminal-notifier dispatch unaffected) while its TTS body queues at position 6

## Scope
- **IN**: FIFO at a configurable path (default `~/Library/Application Support/nexus/tts-queue.fifo`), single drain worker, separate launchctl agent for the worker, `listen | drain` mode argument on the script, ephemeral queue (purged on startup), unchanged banner dispatch, repo-tracked plist
- **OUT**: Bounded queue size with overflow policy (start unbounded; revisit if quota-aware bursts ever overwhelm the queue), disk-persisted queue with replay (start ephemeral; the few-second loss window is acceptable for time-sensitive notifications), priority levels within the queue (FIFO order is sufficient for the homelab use case), drain-worker telemetry (e.g., notifications/min metric — defer to `add-elevenlabs-usage` since playback timing is part of the broader usage story), Linux-side serialization (Linux agent has no `say` analogue and notifications fan out from there to the Mac listener)

## Impact
| Area | Change |
|------|--------|
| Mac runtime | One new launchctl agent (`com.nexus.tts-player`). Listener plist updated to pass explicit `listen` arg. Both plists pick up `KeepAlive` if not already set. |
| Script | `~/bin/nexus-notifier.sh` gains a mode dispatcher at the top, factored helpers for FIFO path / log path / secret loading, new `drain` mode loop. `_dispatch_tts` becomes a one-line `printf '%s\n' "$body" >> "$FIFO"`. |
| Deploy assets | `deploy/com.nexus.tts-player.plist` (new). `deploy/com.nexus.notifier.plist` updated. `deploy/nexus-notifier.sh` updated to the new mode-dispatching shape. |
| State directory | New file at `~/Library/Application Support/nexus/tts-queue.fifo` (mode 0600). |
| Audible behavior | Sequential playback of bursts. No overlap. Slight delay (queue depth × utterance length) between burst notifications when many fire close together. |
| Banner behavior | Unchanged — still fires concurrently and immediately. |

## Risks
| Risk | Mitigation |
|------|-----------|
| Drain worker dies with FIFO writers still attached → producer writes block forever | `KeepAlive` in the plist auto-respawns the worker within seconds; the kernel's FIFO buffer (typically 64KB) absorbs writes during the brief window, and a respawned worker drains them. |
| `say` hangs on a single utterance (audio device contention, very long body) | Wrap the say invocation in a 60-second `timeout` so a stuck utterance is killed and the queue advances; log the truncation so it's diagnosable. |
| Both listener and player simultaneously try to `mkfifo` on cold boot → race | Use `mkfifo` with `2>/dev/null || true` in both modes. The first to succeed creates it; the second silently no-ops on EEXIST. |
| User burst floods unbounded queue and TTS lags hours behind reality | Treat as out-of-scope for v1 — the homelab use case doesn't generate that kind of load. If observed, add a "drop items older than 5 minutes" filter at the player side without changing the producer contract. |
| Queue-related debugging hard to inspect (FIFO is non-readable when consumer is attached) | Provide a fallback diagnostic command `nexus-notifier-status` that reports queue depth (via `lsof` on the FIFO) and last-played item timestamp from the log. |
| launchctl plist sync drift between repo and Mac | Both plists tracked under `deploy/`; the post-merge deploy hook (`deploy/hooks.d/post-merge/02-deploy`) extends to copy them into `~/Library/LaunchAgents/` (currently only handles `com.nexus.agent.plist`). |
