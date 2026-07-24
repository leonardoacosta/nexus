## ADDED Requirements

### Requirement: Pipeline TTS Playback MUST Be Identifiable and Stoppable
The system MUST associate a pipeline-originated TTS clip with the notification id that triggered
it, and MUST expose a working stop control for that clip through the same UI surface used for
manual replay.

#### Scenario: Stop control appears during live pipeline playback
- **GIVEN** `TTSObserver` is speaking a notification via the synth provider chain
- **WHEN** the corresponding notification row is rendered
- **THEN** it shows `stop.circle` (not `play.circle`), matching the manual-replay row's existing
  icon convention

#### Scenario: Tapping stop halts the clip without starting a new one
- **GIVEN** a pipeline clip is playing and its row shows `stop.circle`
- **WHEN** the user taps it
- **THEN** the clip halts immediately and no new clip begins as a side effect

### Requirement: Back-to-Back TTS Events MUST Be Coordinated, Not Independent
The system MUST NOT allow two `tts`-channel `NotificationFired` events arriving within the same
synth-latency window to synthesize and start playback with no coordination between them.

#### Scenario: Second event waits for the first to finish
- **GIVEN** a pipeline clip is already playing
- **AND** a second `tts` event is received before it finishes
- **WHEN** the second event is handled
- **THEN** its synthesis and playback are deferred until the first clip's `onPlaybackFinished`
  fires, then it plays in full (queue-and-play-sequentially — decided in tasks.md task 1.1,
  by:leo) — never an uncoordinated race with the first clip
