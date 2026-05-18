# Proposal: Consolidate Mac TTS Listener — Port Bun Features, Nuke Duplicate

## Change ID
`consolidate-mac-tts-listener`

## Summary
Port the one valuable feature from the duplicate `com.leonardoacosta.nexus-listener` (Bun/TS) listener — banner-click cancels the currently-playing TTS utterance — into the canonical bash notifier (`com.nexus.notifier` + `com.nexus.tts-player`). Then hard-delete the Bun listener's launchd plist, runtime script, and log file to end the active double-audio bug.

## Context
- Extends: `deploy/nexus-notifier.sh` (canonical bash listener + drain worker, repo-tracked)
- Extends: `deploy/com.nexus.notifier.plist` (listen mode launchd agent)
- Extends: `deploy/com.nexus.tts-player.plist` (drain mode launchd agent)
- Removes: `~/Library/LaunchAgents/com.leonardoacosta.nexus-listener.plist` (not repo-tracked)
- Removes: `~/.local/share/nexus-listener.ts` (not repo-tracked, ~13KB)
- Removes: `~/.local/state/nexus-listener.log` (20MB legacy log)
- Related archives: `2026-04-26-add-tts-playback-queue` (FIFO drain architecture), `2026-04-27-restore-tts-mac-audio-dispatch` (audioBase64 path), `2026-04-27-add-notification-control-dashboard` (TTS_ENABLED/BANNER_ENABLED/DUCKING_MODE plumbing)
- Triggering bug: today's `90a5833 fix(notifier): default NEXUS_URL to localhost` unwedged the bash listener after ~3 weeks of silent failure, revealing the latent duplication: bash plays ElevenLabs mp3 via `afplay`, Bun simultaneously plays raw `say` of the same body. Same event id, same second, double audio.

## Motivation

Today's pain (observed 2026-05-16): every TTS notification fires twice — once as the ElevenLabs voice from the canonical bash notifier (`afplay` on the agent-synthesized mp3), once as the macOS `say` voice from the duplicate Bun listener that's still subscribed to the same SSE stream. Side-by-side log evidence at `09:37:45` shows identical event id `cc-1778942265-22319` processed by both listeners within the same second.

Beyond resolving the immediate double-audio bug, this change consolidates a fragmented architecture: two listeners, two log files, two divergent feature sets, and ~3 weeks of half-broken behavior masked by the bash listener's wrong default URL. The bash notifier is the canonical implementation — it ships ElevenLabs synthesis, audio ducking, per-project app bundles, emoji icons, dashboard settings integration, and FIFO-serialized playback. The Bun listener has exactly one feature the bash side lacks: banner-click cancels the currently-playing utterance via `terminal-notifier -execute "kill -TERM <pid>"`. Porting that feature first means decommissioning the Bun listener costs zero UX regression.

The bash 3.2 process-substitution stall the Bun listener was originally built to dodge (`done < <(curl …)` at `deploy/nexus-notifier.sh:524`) is mitigated by `--max-time 1800 --keepalive-time 60` forcing a curl reconnect every 30 minutes — 2+ weeks of production use with zero observed stalls validates the mitigation as sufficient. Rewriting the SSE consumer in Bun is not part of this change.

## Requirements

### Requirement: Bash drain worker MUST publish the currently-playing utterance pid

When `_dispatch_audio` (afplay path) or `_drain_say_one` (FIFO say path) starts a child audio process, the drain SHALL write that child's pid to `~/Library/Application Support/nexus/current-utterance.pid` before the audio begins playing. When the child exits (naturally, via cancel, or via the 60-second timeout cap), the drain SHALL clear the pid file by truncating it to zero bytes.

#### Scenario: ElevenLabs afplay path publishes pid
Given an `audio_b64` payload arrives at `_dispatch_audio`
When `afplay` is spawned in the background
Then `~/Library/Application Support/nexus/current-utterance.pid` SHALL contain the afplay process pid before the function returns
And when afplay exits, the cleanup subshell SHALL truncate the pid file

#### Scenario: Drain say path publishes pid
Given the FIFO has a queued body and the drain worker reads it
When `_drain_say_one` spawns `say` (or `gtimeout 60 say`)
Then `~/Library/Application Support/nexus/current-utterance.pid` SHALL contain the say process pid before the wait
And when say exits, `_drain_say_one` SHALL truncate the pid file

#### Scenario: Atomic pid-file write
Given multiple notifications may dispatch nearly simultaneously
When two pid-file writes race
Then each writer SHALL use `printf '%s' "$pid" > "$pid_file.tmp" && mv "$pid_file.tmp" "$pid_file"` so a reader never sees a partial write

### Requirement: Listener MUST pass the current pid to terminal-notifier as the click-execute target

When the listener's `_dispatch_banner` fires AND `terminal-notifier` is the available banner backend AND the pid file contains a non-empty pid, the dispatch SHALL include `-execute "/bin/kill -TERM <pid>"` in the terminal-notifier args so clicking the banner kills that audio process and advances the queue.

#### Scenario: Banner-click cancels active afplay
Given an ElevenLabs mp3 is playing via afplay (pid in current-utterance.pid)
When the user clicks the banner notification
Then `kill -TERM <afplay-pid>` SHALL fire
And afplay SHALL exit
And the cleanup subshell SHALL truncate the pid file and restore ducking
And the next queued notification (if any) SHALL begin playing

#### Scenario: Banner-click cancels active say
Given a `say` utterance is playing via the drain worker
When the user clicks the banner notification
Then `kill -TERM <say-pid>` SHALL fire
And `say` SHALL exit (graceful — say handles SIGTERM cleanly)
And `_drain_say_one` SHALL clear the pid file and advance to the next FIFO line

#### Scenario: Empty pid file — no cancel target
Given the pid file is empty (no audio currently playing) or absent
When `_dispatch_banner` runs
Then the terminal-notifier args SHALL NOT include `-execute`
And the banner SHALL still fire normally (no-op on click)

#### Scenario: osascript fallback — no execute support
Given terminal-notifier is not installed and the listener falls back to `osascript display notification`
When the banner fires
Then no cancel target SHALL be attached (osascript notifications do not support click handlers)
And this SHALL be logged once at startup as an expected limitation

### Requirement: Cancel SHALL be tolerant of stale or dead pids

Because the pid file is updated asynchronously and the audio process may exit between the listener's read and the user's click, the cancel path SHALL treat `kill -TERM` on a dead or stale pid as a no-op success.

#### Scenario: Stale pid (process already exited)
Given the pid file contains 12345 but pid 12345 is no longer running
When the user clicks the banner
Then `kill -TERM 12345` SHALL exit non-zero
And the listener SHALL NOT log this as an error
And no follow-up action SHALL fire

#### Scenario: Pid file contains garbage
Given the pid file contains non-numeric content (corrupted write, manual edit)
When `_dispatch_banner` reads it
Then the listener SHALL detect non-numeric content via `[[ "$pid" =~ ^[0-9]+$ ]]`
And SHALL treat it as an empty pid (no -execute arg)

### Requirement: Bun listener artifacts MUST be removed from this Mac

After the cancel-port lands and a manual single-audio verification passes, the change SHALL hard-delete every artifact of the duplicate listener so the double-audio cannot regress.

#### Scenario: Launchd agent decommissioned
Given `com.leonardoacosta.nexus-listener` is loaded
When the operator runs `launchctl bootout gui/$UID ~/Library/LaunchAgents/com.leonardoacosta.nexus-listener.plist`
Then `launchctl list | grep com.leonardoacosta.nexus-listener` SHALL return empty
And the Bun process previously holding the SSE connection SHALL exit

#### Scenario: Filesystem artifacts removed
Given the launchd agent is decommissioned
When the operator runs the documented removal sequence
Then `~/Library/LaunchAgents/com.leonardoacosta.nexus-listener.plist` SHALL not exist
And `~/.local/share/nexus-listener.ts` SHALL not exist
And `~/.local/state/nexus-listener.log` (20MB) SHALL not exist
And `~/.local/state/nexus-listener.stdout.log` SHALL not exist
And `~/.local/state/nexus-listener.stderr.log` SHALL not exist

#### Scenario: Reference audit shows no live callers
Given the Bun listener files are removed
When `rg "nexus-listener" ~/.claude/ ~/dev/nx/ ~/bin/ ~/.local/` runs
Then the only matches SHALL be inside `openspec/changes/consolidate-mac-tts-listener/` and `openspec/changes/archive/` (historical references)
And no live script, plist, or hook SHALL reference the Bun listener

### Requirement: Future reinstall SHALL be prevented by a persistent memory note

A `bd remember` entry SHALL be created so future Claude sessions discover the decommissioning rationale via `bd memories nexus-listener` before considering a reinstall.

#### Scenario: Memory note exists
Given the nuke is complete
When `bd memories nexus-listener` runs
Then at least one entry SHALL match
And the entry SHALL explain (a) the bash notifier is canonical, (b) the Bun listener was a parallel implementation that caused double-audio, and (c) the cancel-on-banner-click feature lives in the bash side as of this change.
