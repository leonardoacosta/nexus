# Tasks: consolidate-mac-tts-listener

## UI Batch

> Mac listener / drain script edits. "UI Batch" is the closest phase-classification fit for client-side user-facing dispatch code in the wave plan parser. All edits target `deploy/nexus-notifier.sh` (the canonical bash listener + drain worker).

- [x] 1.1 Add `PID_FILE` constant near the FIFO path (~line 75) — `PID_FILE="${NEXUS_PID_FILE:-$HOME/Library/Application Support/nexus/current-utterance.pid}"` — and add `_ensure_pid_file` helper that idempotently creates the parent dir and chmods 0600.
- [x] 1.2 Add `_write_pid` and `_clear_pid` helpers — `_write_pid` does `printf '%s' "$1" > "${PID_FILE}.tmp" && /bin/mv "${PID_FILE}.tmp" "$PID_FILE"`; `_clear_pid` does `: > "$PID_FILE" 2>/dev/null || true`. Place above `_dispatch_audio`.
- [x] 1.3 Modify `_dispatch_audio` (afplay path) — after `/usr/bin/afplay "$tmp" >>"$LOG_FILE" 2>&1 &` capture `local afpid=$!` (already there), then immediately call `_write_pid "$afpid"`. Modify the cleanup subshell to call `_clear_pid` after `/bin/rm -f "$tmp"` and before `_restore_ducking`.
- [x] 1.4 Modify `_drain_say_one` (FIFO say path) — refactor to launch `say` in the background, capture pid, call `_write_pid`, then `wait`, then `_clear_pid`. Preserve the `gtimeout 60` wrapper semantics by using `( $timeout_cmd /usr/bin/say -- "$line" ) &` then `wait $!`.
- [x] 1.5 Add `_read_active_pid` helper used by the listener — `cat "$PID_FILE" 2>/dev/null | head -c 16`, validate against `^[0-9]+$` regex via `[[ ... =~ ... ]]`, return empty string on invalid.
- [x] 1.6 Modify `_dispatch_banner` — call `_read_active_pid` into a local var; when non-empty AND terminal-notifier branch is taken, append `-execute "/bin/kill -TERM $pid"` to the args array before invoking terminal-notifier. The osascript fallback branch SHALL NOT attempt to attach a cancel target.
- [x] 1.7 Add one-time startup log in `_run_listen` after `_bootstrap_settings` — if neither `/opt/homebrew/bin/terminal-notifier` nor `/usr/local/bin/terminal-notifier` is executable, log `terminal-notifier not found; banner-click cancel disabled (osascript fallback)`. Logged ONCE at startup, not per dispatch.
- [x] 1.8 Update `_ensure_fifo` to also call `_ensure_pid_file` (single bootstrap helper invocation) so both files exist before either mode (listen or drain) begins reading/writing.
- [x] 1.9 Add bash unit test cases in `deploy/tests/nexus-notifier-modes.test.sh` — (a) `_write_pid` is atomic under concurrent invocation; (b) `_read_active_pid` rejects non-numeric content; (c) `_dispatch_banner` includes `-execute` when pid file is populated; (d) `_dispatch_banner` omits `-execute` when pid file is empty.
- [x] 1.10 Mirror the edits in the installed copy — `cp deploy/nexus-notifier.sh ~/bin/nexus-notifier.sh && chmod 0755 ~/bin/nexus-notifier.sh` (the launchd plist points at `~/bin/`).
- [x] 1.11 Reload both launchd agents to pick up the new script — `launchctl bootout gui/$UID ~/Library/LaunchAgents/com.nexus.notifier.plist && launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.nexus.notifier.plist`, repeat for `com.nexus.tts-player.plist`. Verify `launchctl list | grep nexus` shows both as running.

## E2E Batch

> Verification + decommissioning steps. These are sequenced after the UI batch lands so the cancel feature exists before the Bun listener is removed.

- [ ] 2.1 Manual verification: cancel works on afplay path — fire `nx_notify "$(seq 1 80 | xargs)"`, click banner mid-utterance, confirm audio stops within ~100ms, confirm `cat "$HOME/Library/Application Support/nexus/current-utterance.pid"` is empty afterward, confirm `~/Library/Logs/nexus-notifier.log` shows the kill in the cleanup subshell.
- [ ] 2.2 Manual verification: cancel works on say fallback path — temporarily unset `ELEVENLABS_API_KEY` for the agent (or use an event without audioBase64), fire `nx_notify "$(seq 1 80 | xargs)"`, click banner, confirm `say` stops gracefully and pid file clears.
- [ ] 2.3 Manual verification: stale-pid click is harmless — manually `echo 99999 > "$HOME/Library/Application Support/nexus/current-utterance.pid"`, fire a notification, click banner, confirm no error fires anywhere (terminal-notifier log, nexus-notifier.log).
- [ ] 2.4 Manual verification: garbage-pid click is harmless — `echo "not-a-pid" > "$HOME/Library/Application Support/nexus/current-utterance.pid"`, fire a notification, confirm banner fires without `-execute` attached and no error in logs.
- [x] 2.5 Decommission Bun listener — `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.leonardoacosta.nexus-listener.plist`. Verify `launchctl list | grep com.leonardoacosta.nexus-listener` exits non-zero with no output.
- [x] 2.6 Remove Bun listener filesystem artifacts — `rm ~/Library/LaunchAgents/com.leonardoacosta.nexus-listener.plist`, `rm ~/.local/share/nexus-listener.ts`, `rm ~/.local/state/nexus-listener.log`, `rm ~/.local/state/nexus-listener.stdout.log`, `rm ~/.local/state/nexus-listener.stderr.log`.
- [x] 2.7 Reference audit — `rg -l "nexus-listener" ~/.claude/ ~/dev/nx/ ~/bin/ ~/.local/ 2>/dev/null`. The only matches MUST be under `openspec/changes/consolidate-mac-tts-listener/` and `openspec/changes/archive/`. If any live script or config matches, escalate before continuing.
- [x] 2.8 Memory note — `bd remember "Mac TTS: com.nexus.notifier (bash) is canonical. com.leonardoacosta.nexus-listener (Bun) was decommissioned 2026-05-16 due to double-audio (both subscribed to the same SSE stream). Banner-click cancel was ported into bash via ~/Library/Application Support/nexus/current-utterance.pid IPC. Do not reinstall."`
- [x] 2.9 Single-audio verification — fire `nx_notify "single audio verification ping"`, listen for exactly one voice. Verify `~/Library/Logs/nexus-notifier.log` has exactly one `tts+banner:` line for that ping. Verify `launchctl list | grep nexus` shows only `com.nexus.agent`, `com.nexus.notifier`, `com.nexus.tts-player`.
- [ ] 2.10 Commit and push — `git add deploy/nexus-notifier.sh deploy/tests/nexus-notifier-modes.test.sh openspec/changes/consolidate-mac-tts-listener/ .beads/ && git commit -m "feat(notifier): port banner-click cancel from Bun listener; nuke duplicate" && git push`.
