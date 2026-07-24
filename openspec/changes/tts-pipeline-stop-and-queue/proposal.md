---
order: 0724k
---

# Proposal: Give Pipeline-Originated TTS Clips a Stop Control and Playback Queue

## Change ID
`tts-pipeline-stop-and-queue`

## Summary
`TTSObserver.playMP3()` starts pipeline-originated TTS audio via `AudioPlayer.play(mp3Data:ducking:)`
but never calls `AudioPlayer.shared.setCurrentlyPlaying(id:)` — only the manual-replay path
(`NotificationReplayButton.swift:80`) does. The replay row's play/stop icon is driven entirely by
`currentlyPlayingId == notificationId` (`NotificationReplayButton.swift:28-30`), so while a
pipeline clip is audibly speaking, every row still shows `play.circle`, never `stop.circle` — there
is no correct, visible stop control for live TTS. Separately, back-to-back `tts`-channel events
(e.g. two ladder-threshold notifications firing in one tick) each independently synth+play with no
serialization, so they land one after another with no way to skip ahead. Give pipeline clips a real
playing identity and a serialize/skip queue.

## Context
- depends on: `fix-swift-tts-audit-defects`
- touches: `apps/swift/NexusShared/Observers/TTSObserver.swift`, `apps/swift/nexus-mac/Sources/AudioPlayer.swift`, `apps/swift/nexus-mac/Sources/Dashboard/NotificationReplayButton.swift`, `apps/swift/nexus-mac/Tests/TTSObserverTests.swift`, `apps/swift/nexus-mac/Tests/AudioControlTests.swift`
- base-commit: nexus@9e4963b9

## Motivation
Found via `/explore` ("nexus headroom tts plays all at once, why?", 2026-07-24) — "press play to
stop tts isn't working" traced to `TTSObserver.swift:875-894`'s `playMP3()` never setting
`currentlyPlayingId`, confirmed by reading `NotificationReplayButton.swift:28-30,53-58`: `isPlaying`
(and therefore which icon renders) is keyed solely to that id, which only the manual replay path
(`:80`) sets. A live pipeline clip is invisible to every row's icon. Separately, `TTSObserver.handle()`
processes `tts` events serially per SSE frame but returns as soon as playback *starts* (`playMP3`
never awaits clip duration), so consecutive events (the credential-headroom ladder can fire two in
one tick — see the sibling proposal `route-service-notifications-through-manager`) each kick off
their own synth+play with zero coordination — no way to skip a queued clip, no visible indication
more than one is pending.

## Testing
- `TTSObserverTests.swift` (new case): after `synthesise()`/`playMP3()` completes, the injected
  player spy records a `setCurrentlyPlaying`-equivalent call (or the observer's own tracked "now
  speaking" id, depending on the chosen design) matching the event id.
- `AudioControlTests.swift` (new case): a `NotificationReplayButton` row matching the currently
  *pipeline-playing* event id renders `stop.circle`, and tapping it halts audio with no new clip
  starting.
- New case: two `tts` events delivered back-to-back — assert either (a) the second waits for the
  first's `onPlaybackFinished` before synthesizing, or (b) the second is dropped/coalesced per
  whatever ladder-burst policy this proposal settles on — record the chosen behavior in `design.md`
  before implementing, since both are defensible and the spec delta must commit to one.
- Gate: `xcodebuild -scheme nexus-mac test -only-testing:nexus-mac-Tests -only-testing:NexusSharedTests` (or the ssh-mac `swiftc -typecheck` contract when no Mac runner is available in-session).

## Done Means
- While a pipeline-originated TTS clip is audibly playing, its corresponding notification row (if
  one exists) shows `stop.circle`, and tapping it halts the clip without starting a different one.
- Two `tts`-channel notifications arriving within the same synth-latency window play back
  sequentially (or the second is deliberately dropped per the design decision above) — never both
  audibly overlapping with no coordination.
- No regression to the existing manual-replay play/stop toggle behavior.

## Preconditions
- `NotificationReplayButton.swift` exists and its `isPlaying` is keyed to `currentlyPlayingId`: `grep -n "currentlyPlayingId == notificationId" apps/swift/nexus-mac/Sources/Dashboard/NotificationReplayButton.swift` → line 29.
- `TTSObserver.playMP3()` never calls `setCurrentlyPlaying`: `grep -n "setCurrentlyPlaying" apps/swift/NexusShared/Observers/TTSObserver.swift` → no match (confirms the gap).
- A Mac build target is reachable for verification (`ssh mac` + xcodebuild, per repo convention) — this repo has no Linux-side Swift build.

## Scope
- **IN**: giving `TTSObserver`'s pipeline playback a "currently playing" identity the replay UI
  can observe/control (either reusing `AudioPlayer.shared.currentlyPlayingId` with the event's own
  id, or a new dedicated published property — design.md decides), a minimal FIFO/skip policy for
  back-to-back `tts` events, and the corresponding UI + test coverage.
- **OUT**: the agent-side notification-source bypass fix (separate proposal
  `route-service-notifications-through-manager`), the 4 unrelated defects in the open
  `fix-swift-tts-audit-defects` proposal (this proposal should land after or alongside it, not
  duplicate its fixes — both touch `AudioPlayer.swift`/`TTSObserver.swift`, coordinate via
  `- depends on:` if sequencing becomes necessary at wave-plan time), ducking logic, watchOS/iOS
  targets.
