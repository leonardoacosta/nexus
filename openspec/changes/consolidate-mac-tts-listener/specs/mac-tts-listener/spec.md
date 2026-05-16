# Spec Delta: mac-tts-listener

## ADDED Requirements

### Requirement: Drain worker publishes currently-playing audio pid to a shared file

The Mac TTS playback subsystem SHALL maintain a single shared pid file at `~/Library/Application Support/nexus/current-utterance.pid` whose contents reflect the pid of the currently-playing audio child process. Both the listener-side afplay path (ElevenLabs mp3) and the drain-side say path (FIFO fallback) SHALL write to this file before the child begins playing and clear it when the child exits.

#### Scenario: afplay path writes pid atomically
Given a `NotificationFired` event carries a non-empty `payload.audioBase64`
When the listener decodes the mp3 and spawns `afplay` in the background
Then the listener SHALL write `$!` to `current-utterance.pid` via a `printf > .tmp && mv .tmp <pidfile>` atomic sequence
And SHALL do so before any banner dispatch that may reference the pid

#### Scenario: afplay exit clears pid file
Given afplay is running with its pid in the pid file
When afplay exits for any reason (natural completion, kill -TERM, OS-level kill)
Then the cleanup subshell SHALL truncate the pid file to zero bytes via `: > <pidfile>`
And SHALL do so before restoring audio ducking state

#### Scenario: Drain say path writes pid atomically
Given the FIFO drain worker reads a body line
When `_drain_say_one` spawns `/usr/bin/say` (with or without the `gtimeout 60` wrapper)
Then the drain SHALL write the say child's pid to the same atomic-write path
And SHALL clear the pid file after `say` exits, before reading the next FIFO line

#### Scenario: Concurrent writers do not corrupt the pid file
Given two audio paths race (a misconfiguration where afplay and drain both run)
When both attempt to write the pid file
Then the atomic `mv` semantics SHALL guarantee a reader sees one complete pid or the other, never a partial write

### Requirement: Banner dispatch attaches a kill-on-click target when a pid is current

When the bash listener dispatches a banner via `terminal-notifier` AND the pid file contains a valid numeric pid, the dispatch SHALL include `-execute "/bin/kill -TERM <pid>"` so the user can cancel the currently-playing utterance by clicking the banner.

#### Scenario: Active afplay cancellable via banner click
Given an ElevenLabs mp3 is playing via afplay
And `current-utterance.pid` contains the afplay pid
When `_dispatch_banner` runs for a subsequent (or the same) notification
Then the terminal-notifier args SHALL include `-execute "/bin/kill -TERM <pid>"`
And clicking the banner SHALL terminate afplay within 100ms
And the cleanup subshell SHALL restore ducking and clear the pid file
And the next queued notification (if any) SHALL begin playing

#### Scenario: Active say cancellable via banner click
Given the drain worker is currently speaking via `/usr/bin/say`
And `current-utterance.pid` contains the say pid
When `_dispatch_banner` runs
Then the terminal-notifier args SHALL include `-execute "/bin/kill -TERM <pid>"`
And clicking the banner SHALL terminate `say` gracefully (SIGTERM)
And `_drain_say_one` SHALL clear the pid file and advance to the next FIFO line

#### Scenario: No active audio — banner has no cancel target
Given the pid file is empty or missing
When `_dispatch_banner` runs
Then the terminal-notifier args SHALL NOT include `-execute`
And the banner SHALL still fire normally
And clicking the banner SHALL be a no-op (terminal-notifier's default behavior)

#### Scenario: Pid file contains non-numeric content
Given the pid file contains corrupted or non-numeric content
When the listener reads it
Then the read SHALL validate the content against `^[0-9]+$`
And SHALL treat invalid content as an empty pid (no -execute)
And SHALL NOT crash, log an error at error-level, or block the banner

#### Scenario: Stale pid (process already exited) on click
Given the pid file contains a pid whose process has already exited (race)
When the user clicks the banner
Then `/bin/kill -TERM <pid>` SHALL fail silently (terminal-notifier ignores -execute exit code)
And no follow-up action SHALL fire
And the next dispatch SHALL overwrite the stale pid normally

#### Scenario: osascript fallback path — cancel not supported
Given terminal-notifier is not installed at any known path
When the listener falls back to `osascript display notification`
Then the banner SHALL fire without any cancel target attached
And the listener SHALL log this limitation once at startup, not per-dispatch

### Requirement: Duplicate Bun TS listener artifacts SHALL be absent from this Mac

Once the cancel-port lands and single-audio verification passes, the operator SHALL decommission the duplicate `com.leonardoacosta.nexus-listener` launchd agent and remove all associated files so the double-audio failure mode cannot recur.

#### Scenario: launchctl reports the duplicate agent as not loaded
Given the nuke sequence has completed
When `launchctl list | grep com.leonardoacosta.nexus-listener` runs
Then the command SHALL exit non-zero with no matching output

#### Scenario: Plist file removed
Given the launchd agent is decommissioned
When `ls ~/Library/LaunchAgents/com.leonardoacosta.nexus-listener.plist` runs
Then the command SHALL exit non-zero with "No such file or directory"

#### Scenario: Runtime script and logs removed
Given the nuke sequence has completed
When the operator inspects `~/.local/share/` and `~/.local/state/`
Then `nexus-listener.ts` SHALL NOT exist in `~/.local/share/`
And `nexus-listener.log`, `nexus-listener.stdout.log`, `nexus-listener.stderr.log` SHALL NOT exist in `~/.local/state/`

#### Scenario: No live references remain in scripts or config
Given the artifacts are removed
When `rg -l "nexus-listener" ~/.claude/ ~/dev/nx/ ~/bin/ ~/.local/ 2>/dev/null` runs
Then matches SHALL be limited to `openspec/changes/consolidate-mac-tts-listener/` and `openspec/changes/archive/`
And no shell script, plist, hook, or runtime config SHALL reference the Bun listener

### Requirement: A persistent memory note SHALL document the decommissioning

A `bd remember` entry SHALL be created so future Claude sessions can discover the consolidation history via `bd memories nexus-listener` and avoid recreating the duplicate.

#### Scenario: Memory note discoverable
Given the nuke is complete
When `bd memories nexus-listener` runs
Then at least one entry SHALL match the keyword
And the entry SHALL identify the bash notifier (`com.nexus.notifier`) as canonical
And the entry SHALL identify the Bun listener (`com.leonardoacosta.nexus-listener`) as decommissioned 2026-05-16 due to double-audio
And the entry SHALL note that banner-click cancel was ported into the bash side via `current-utterance.pid` IPC

### Requirement: Single-audio verification SHALL pass after decommissioning

A manual verification step SHALL confirm that exactly one audio rendering plays per notification after the nuke completes, distinguishing successful consolidation from a regression where another duplicate (e.g., a stale process) is still active.

#### Scenario: Single audio per notification
Given the nuke sequence has completed
When the operator fires `nx_notify "single audio verification ping"` from this Mac
Then exactly one audio rendering SHALL play (ElevenLabs voice via afplay when key is configured, else `say` fallback)
And `~/Library/Logs/nexus-notifier.log` SHALL show exactly one `tts+banner:` log line for that notification
And no entry SHALL exist for that notification in `~/.local/state/nexus-listener.log` (file is removed)

#### Scenario: launchctl shows only canonical nexus agents
Given the nuke sequence has completed
When `launchctl list | grep nexus` runs
Then the output SHALL include `com.nexus.agent`, `com.nexus.notifier`, `com.nexus.tts-player`
And SHALL NOT include `com.leonardoacosta.nexus-listener`
