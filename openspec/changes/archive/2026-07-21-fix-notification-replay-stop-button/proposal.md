---
order: 0720e
---

# Proposal: Fix notification-drawer replay button so a second click stops playback

## Change ID
`fix-notification-replay-stop-button`

## Summary
The notification-history drawer's per-row replay button is supposed to toggle: tap once to
play, tap again while it's playing to stop. It currently shows a stop icon while playing but
the button is `.disabled(isPlaying)` at that exact moment, so the tap that's supposed to stop
it never registers. Even if the disabled gate were removed, there is no stop branch in the
button's tap handler at all — it only ever calls `play()`, never `AudioPlayer.stop()` — and the
`isPlaying` flag itself is set back to `false` as soon as the async `play()` call *returns*
(kicks off playback), not when the audio actually finishes, so it doesn't track real playback
state for more than an instant.

## Context
- Extends: `apps/swift/nexus-mac/Sources/Dashboard/NotificationReplayButton.swift`,
  `apps/swift/nexus-mac/Sources/AudioPlayer.swift`
- Related: `openspec/specs/swift-menubar-client/spec.md` — the `notification-replay-button`
  requirement that specifies this exact stop-on-second-tap contract was added in the archived
  `2026-05-21-notifications-overhaul` change but never made it into the live merged capability
  spec (confirmed via `grep` — the requirement text is absent from
  `openspec/specs/swift-menubar-client/spec.md`). This proposal both fixes the implementation
  and restores the missing requirement.
- depends on: (none)
- touches: `apps/swift/nexus-mac/Sources/Dashboard/NotificationReplayButton.swift`, `apps/swift/nexus-mac/Sources/AudioPlayer.swift`

> **Two parser-visible contracts.** `/triage` reads `- depends on:`; `wave-plan-build` reads
> `- touches:`.

## Motivation
The stop affordance is user-visible false advertising: the button renders a stop icon that
cannot be clicked. An operator who starts replaying a notification and wants to silence it
(e.g. accidentally tapped the wrong row, or the audio is long and they've heard enough) has no
way to do so short of waiting it out.

## Non-Goals
- The cancel-on-tab-change scenario from the original `notification-replay-button` requirement
  (in-flight network request cancels cleanly on tab switch) — separate concern, not reported as
  broken, not touched here.
- Any change to the live TTSObserver real-time speech pipeline (kokoro/ElevenLabs/system-voice
  chain) — this proposal only touches the notification-history drawer's on-demand replay path,
  a distinct playback surface using the same `AudioPlayer` singleton.
- Cross-row behavior is resolved: clicking a different row's play button while another row is
  playing stops the current playback and starts the new one (single-channel player, matches the
  existing `AudioPlayer.shared` singleton).

## Done Means
- Clicking a row's play button while that same row is already playing stops the audio
  immediately and the button reverts to the play icon.
- Clicking a different row's play button while another row is playing stops the current
  playback and starts the new row's audio.
- The button's visual state (play icon vs. stop icon) accurately reflects whether audio is
  actually playing for the full duration of playback, not just the instant the network fetch
  returns.

## Testing
- Unit/UI test coverage for `NotificationReplayButton`'s tap-toggle behavior (same-row stop,
  cross-row switch, icon state tracking playback lifecycle) — see tasks 1.2, 1.3.
- Manual on-device verification (`[user:post]`) — SwiftUI button interaction and audio playback
  cannot be exercised headlessly from Linux; the typecheck gate proves the code compiles but not
  that the tap actually stops audio on a real Mac.
