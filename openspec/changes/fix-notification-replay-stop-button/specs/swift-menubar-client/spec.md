# swift-menubar-client Delta

## ADDED Requirements

### Requirement: notification-replay-button-toggle

Each notification-drawer row's replay button MUST toggle between play and stop. Tapping the
button while idle MUST start playback of that row's audio via the shared `AudioPlayer`
singleton and show a stop icon. Tapping the button while that same row's audio is actively
playing MUST call `AudioPlayer.stop()` and revert the button to the play icon. Tapping a
DIFFERENT row's play button while another row is playing MUST stop the current playback before
starting the new row's audio (single-channel player — only one row's audio plays at a time).
The button's play/stop icon state MUST track actual playback state for the full duration of
playback, not just the instant the audio fetch call returns.

#### Scenario: second tap on the playing row stops it

- **Given** a notification row's replay button was tapped and its audio is actively playing
- **When** the user taps the same row's button again
- **Then** `AudioPlayer.stop()` is called
- **AND** the button immediately reverts to the play icon
- **AND** no audio continues playing

#### Scenario: tapping a different row switches playback

- **Given** row A's audio is actively playing
- **When** the user taps row B's replay button
- **Then** row A's playback stops and its button reverts to the play icon
- **AND** row B's audio begins playing and its button shows the stop icon

#### Scenario: icon state persists for the full playback duration

- **Given** a row's replay button was tapped and the audio fetch has completed (playback started)
- **When** several seconds pass while the audio is still playing
- **Then** the button continues showing the stop icon (not reverted to play early)
- **AND** when playback finishes naturally (not via a stop tap), the button reverts to the play
  icon automatically
