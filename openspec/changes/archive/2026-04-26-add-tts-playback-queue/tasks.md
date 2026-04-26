# Implementation Tasks

<!-- beads:epic:nx-m0hr5 -->
<!-- beads:feature:nx-b8h2p -->

## DB Batch

(None — this change is filesystem + launchctl only.)

## API Batch

- [x] [2.1] [P-1] Refactor `~/bin/nexus-notifier.sh` to accept a `listen | drain` mode arg. Factor FIFO path, log path, secret loading into shared helpers at the top of the file. Default mode is `listen` for backwards compatibility. [owner:api-engineer] [type:config] [beads:nx-lv901]
- [x] [2.2] [P-1] Implement `listen` mode: replace `_dispatch_tts`'s `say "$body" &` with `printf '%s\n' "$body" >> "$FIFO"`. Add FIFO creation at startup (mkfifo, mode 0600, purge stale). [owner:api-engineer] [type:config] [beads:nx-pp9l7]
- [x] [2.3] [P-1] Implement `drain` mode: `while IFS= read -r line; do timeout 60 /usr/bin/say -- "$line"; done < "$FIFO"`. Wrap `say` in a 60s timeout so a stuck utterance doesn't block the queue. [owner:api-engineer] [type:config] [beads:nx-l422b]
- [x] [2.4] [P-2] Update `deploy/nexus-notifier.sh` to match the deployed version. [owner:api-engineer] [type:config] [beads:nx-rl34p]
- [x] [2.5] [P-2] Add `deploy/com.nexus.tts-player.plist` (KeepAlive=true, ProgramArguments=`["~/bin/nexus-notifier.sh", "drain"]`, RunAtLoad=true, StandardOutPath/StandardErrorPath set to `~/Library/Logs/nexus-tts-player.{stdout,stderr}.log`). [owner:devops-engineer] [type:config] [beads:nx-5jvep]
- [x] [2.6] [P-2] Update `deploy/com.nexus.notifier.plist` to pass `listen` as an explicit ProgramArgument and ensure KeepAlive=true. [owner:devops-engineer] [type:config] [beads:nx-wnd0l]
- [x] [2.7] [P-2] Extend `deploy/hooks.d/post-merge/02-deploy` to copy both notifier plists into `~/Library/LaunchAgents/` and reload via `launchctl bootout && launchctl load`. Currently only handles `com.nexus.agent.plist`. [owner:devops-engineer] [type:ci-cd] [beads:nx-1o6gt]
- [x] [2.8] [P-3] Add diagnostic command `~/bin/nexus-notifier-status` that reports queue depth (via `lsof` on FIFO), drain-worker PID, last log entry. [owner:api-engineer] [type:config] [beads:nx-7z48y]

## UI Batch

(None — no dashboard surface.)

## E2E Batch

- [x] [4.1] Manual reproducer doc in `docs/testing/tts-queue-burst.md`: `for i in 1 2 3 4 5; do nx_notify "Burst test number $i, listen for serial playback"; done`. Documents expected behavior (5 sequential utterances, no overlap) and how to verify via log timestamps. [owner:e2e-engineer] [type:docs] [beads:nx-esvcn]
- [x] [4.2] Bash unit test for the `listen | drain` mode dispatcher (CI-friendly — does not require macOS). Mocks the FIFO and asserts each mode invokes the right code path. [owner:test-writer] [type:testing] [beads:nx-e42il]
- [x] [4.3] Mac integration test (script): launches both modes, writes 3 messages to the FIFO, asserts the drain log shows 3 sequential entries with non-overlapping timestamps. Skipped on Linux CI. [owner:e2e-engineer] [type:testing] [beads:nx-pn21t]
