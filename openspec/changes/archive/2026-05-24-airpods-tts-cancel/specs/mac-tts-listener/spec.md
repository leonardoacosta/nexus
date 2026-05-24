## ADDED Requirements

### Requirement: In-flight TTS playback MUST be cancellable

The TTS playback layer MUST expose a way to stop audio that is currently playing. `MP3PlayerProtocol` MUST gain a `stop()` method that halts the current `AVAudioPlayer` immediately, and the `AVSpeechSynthesizer` fallback path MUST be cancellable via `stopSpeaking(at: .immediate)`. Calling stop when nothing is playing MUST be a safe no-op.

#### Scenario: Stop halts active MP3 playback

- **GIVEN** a synthesized MP3 is playing through the `MP3Player`
- **WHEN** `stop()` is called
- **THEN** audio output ceases within ~100ms and the player is left ready for the next `play()`

#### Scenario: Stop cancels the speech-synth fallback

- **GIVEN** the `AVSpeechSynthesizer` fallback is mid-utterance (ElevenLabs unavailable)
- **WHEN** the cancel path runs
- **THEN** `stopSpeaking(at: .immediate)` is invoked and speech stops

#### Scenario: Stop with nothing playing is a no-op

- **GIVEN** no TTS audio is playing
- **WHEN** `stop()` is called
- **THEN** it returns without error and no state changes

### Requirement: The app MUST own the Now-Playing session during TTS playback plus a grace window

A `NowPlayingController` MUST acquire the system Now-Playing session (`MPNowPlayingInfoCenter.default().nowPlayingInfo` populated + playback state `.playing`) when TTS playback begins, and MUST resign it (clear now-playing info, disable remote commands) after playback ends plus a 2-second grace window. The grace window MUST reset if a new TTS clip starts before it elapses.

#### Scenario: Session acquired on TTS start

- **GIVEN** a TTS notification begins playing
- **WHEN** playback starts
- **THEN** the app is the system Now-Playing source and its remote-command handlers are enabled

#### Scenario: Session held through the 2-second grace window

- **GIVEN** a TTS clip finished playing 1 second ago
- **WHEN** the user presses the AirPods button
- **THEN** the app still receives the remote command (grace window has not elapsed)

#### Scenario: Session resigned after grace elapses

- **GIVEN** a TTS clip finished playing more than 2 seconds ago with no further activity
- **WHEN** the grace timer fires
- **THEN** the app clears its Now-Playing info and remote-command control returns to the prior media app

#### Scenario: Grace window resets on a new clip

- **GIVEN** the grace window is counting down after one clip
- **WHEN** a second TTS clip starts before 2 seconds elapse
- **THEN** the Now-Playing session is retained and the grace window restarts when the second clip ends

### Requirement: A play/pause press during TTS MUST cancel the in-flight TTS

While TTS audio is playing, an `MPRemoteCommandCenter.togglePlayPauseCommand` (also `playCommand`/`pauseCommand`) event MUST cancel the in-flight TTS (stop audio + speech-synth) and return `.success`, consuming the command so it does not propagate to other media apps.

#### Scenario: Single press cancels active TTS

- **GIVEN** a TTS notification is playing and the app owns the Now-Playing session
- **WHEN** the user single-presses the AirPods stem (toggle play/pause)
- **THEN** the TTS audio stops immediately and the handler returns `.success`

#### Scenario: Press with no active TTS in the grace window does not error

- **GIVEN** TTS already finished but the app still owns the session (within grace)
- **WHEN** a play/pause press arrives
- **THEN** the handler returns `.success` without crashing (no audio to cancel; the press is consumed). NOTE: the follow-up `airpods-stt-command` repurposes this grace-window press to start dictation; until that ships, it is a safe no-op.
