# tts-playback Specification

## Purpose
Serialize Mac-side TTS playback so concurrent notifications never overlap into garbled audio, while keeping the SSE listener responsive to incoming events. Establishes the playback worker as a separate launchctl agent so audio-device wedges (rare but real) can recover without affecting the SSE subscription.

## ADDED Requirements

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
