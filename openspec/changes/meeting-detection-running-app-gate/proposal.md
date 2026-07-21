---
order: 0721a
---

# Proposal: Loosen Meeting Detection to a Running-App Gate

## Change ID
`meeting-detection-running-app-gate`

## Summary
`PresenceSensing.isMeeting()` currently requires the meeting app to be **frontmost**, not merely open, before it will report `inMeeting: true`. The instant the user alt-tabs away from Zoom/Teams/etc — e.g. to check a Claude Code notification or take notes in another app while still on the call — `isMeeting()` flips to `false`, presence-aware routing's Rule 1 fires, and TTS speaks at full "active" interruption level mid-meeting. Replace the frontmost check with a running-app check: `(camera OR mic) IS-RUNNING-SOMEWHERE AND a known meeting app is in `NSWorkspace.shared.runningApplications``. The camera/mic gate (the guarantee that camera-alone use with no meeting app open — Photo Booth, Continuity Camera — never counts) is unchanged.

## Context
- Extends: `apps/swift/NexusShared/Observers/PresenceObserver.swift` (`RawSignals`, `PresenceSensing.isMeeting()`, the live signal collector)
- Extends: `apps/swift/NexusSharedTests/PresenceObserverTests.swift`
- Modifies: `openspec/specs/context-aware-routing/spec.md` — "Meeting Detection via Camera and Mic" requirement (originally shipped by `openspec/changes/archive/2026-06-20-mac-presence-observer/`, decision Q2)
- depends on:
- touches: `apps/swift/NexusShared/Observers/PresenceObserver.swift`, `apps/swift/NexusSharedTests/PresenceObserverTests.swift`, `openspec/specs/context-aware-routing/spec.md`

## Motivation
Found via `/explore` ("TTS does not respect meeting presence and TTS is still sounding off twice on the mac", 2026-07-21). The `nexus-presence` LaunchAgent is confirmed running and correctly reporting on the live Mac — this is not a wiring gap. It is a design gap in the AND-gate itself: requiring literal window focus on the meeting app defeats the feature for the exact workflow it exists to protect — a developer glancing at code/notifications/Slack while still on a call, camera/mic still live. `isFalse(vector.inMeeting)` in `apps/agent/src/notifications/rules-engine.ts` Rule 1 only matches on a *known-false* `inMeeting`, so a definite (not stale/unknown) false report from the observer is what lets TTS fire loud mid-meeting.

Decision (this proposal, superseding the "frontmost" half of decision Q2 only): a running-app check is simpler than a time-based latch — no grace-period constant to tune, and `inMeeting` stays true for exactly as long as the call app is open and a capture device is live, with no separate expiry logic to test. The camera-alone-with-no-meeting-app guarantee is preserved unchanged since the AND-gate itself (camera-or-mic AND a meeting app) is untouched — only which app *state* counts (running vs. frontmost) changes.

## Testing
- `apps/swift/NexusSharedTests/PresenceObserverTests.swift` — unit tests exercise `PresenceSensing.isMeeting(_:)` purely (no live hardware): meeting app running-but-not-frontmost with camera/mic active → `true`; meeting app not running at all (even if it was frontmost stale data) → `false`; camera-alone with a meeting app running but idle (no capture device) → `false` (guarantee preserved); multiple running apps where only one is a meeting app → `true`.
- No E2E/live-hardware verification in this proposal — `PresenceSensing` is deliberately hardware-free per its own file header ("Testability" section); a `[user:post]` on-device check is out of scope here and tracked by the existing on-device-verification beads already open under this capability's epic.

## Done Means
- With a meeting app (Zoom/Teams/etc.) open and camera or mic active, switching focus to another app (terminal, editor, Slack) no longer causes TTS notifications to interrupt at "active" level — they hold/buffer as if still in the meeting.
- Quitting the meeting app, or camera/mic both going idle, still resolves `inMeeting` back to `false` so notifications aren't held after a meeting genuinely ends.
- Camera-alone use with no meeting app running (Photo Booth, Continuity Camera) still never reports `inMeeting: true`.

## Scope
- **IN**: `RawSignals` gains a running-bundle-ids signal; `isMeeting()` checks it against `meetingBundleIds` instead of `frontmostBundleId`; the live collector populates it via `NSWorkspace.shared.runningApplications`; `frontmostBundleId` (now unused by `isMeeting()`) and its live collector are removed as dead code; spec delta on the shipped `context-aware-routing` requirement; unit test coverage for the new gate shape.
- **OUT**: any time-based latch/grace-window mechanism (considered, rejected in favor of the simpler running-app check — see Motivation); widening `meetingBundleIds` itself (a separate, orthogonal gap — e.g. Safari/Arc are not in the list — not part of this proposal); changes to `rules-engine.ts` or any other Rule (this proposal only changes what the *sensor* reports, not how the rules engine consumes `inMeeting`).
