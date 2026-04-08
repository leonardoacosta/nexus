# Spec: Module Extraction

## ADDED Requirements

### Requirement: Desktop notification module
The system MUST extract `show_notification` from `delivery.rs` into `desktop.rs` as a free async function.

#### Scenario: macOS desktop notification
Given the platform is macOS
When `desktop::show_notification("Title", "message", Some("proj"))` is called
Then it invokes Nexus-Notifier.app or falls back to terminal-notifier
And returns without error even if the notifier binary is missing

#### Scenario: Linux desktop notification
Given the platform is Linux
When `desktop::show_notification("Title", "message", None)` is called
Then it invokes `notify-send`
And returns without error even if notify-send is not installed

### Requirement: Audio playback utilities in audio module
The system MUST move `play_audio_file` and `probe_audio_health` into `audio.rs` alongside the existing `AudioController`.

#### Scenario: Audio file playback
Given an MP3 file exists at a path
When `audio::play_audio_file("/tmp/tts.mp3")` is called
Then it tries platform-appropriate players (afplay on macOS; mpv, ffplay, paplay, aplay on Linux)
And returns `Ok(())` on the first successful player
And returns `Err` only when no player succeeds

#### Scenario: Audio health probe
When `audio::probe_audio_health()` is called
Then it returns an `AudioHealth` struct with `output_available`, `elevenlabs_key_set`, `system_tts`, `last_successful_play`, and `notification_mode` fields

### Requirement: Watch delivery module
The system MUST move `deliver_to_watch` to `watch.rs` and SHALL extract config validation into `WatchDeliveryConfig::try_from`.

#### Scenario: Watch delivery with valid config
Given watch notifications are enabled with valid APNS credentials
And at least one active device token exists
When `watch::deliver_to_watch(message, project, type, mode, message_id)` is called
Then it sends APNS notifications to all active devices
And invalidates expired tokens on `TokenExpired` response

#### Scenario: Watch delivery with missing config
Given watch `apns_key_id` is not configured
When `watch::deliver_to_watch(...)` is called
Then it logs a warning and returns without error

#### Scenario: Watch delivery in silent mode
Given notification mode is Silent
When `watch::deliver_to_watch(...)` is called
Then it skips delivery and returns immediately

### Requirement: iMessage module
The system MUST move `send_imessage` (macOS impl + non-macOS stub) to `imessage.rs`.

#### Scenario: iMessage on macOS
Given the platform is macOS
When `imessage::send("recipient", "message")` is called
Then it executes the AppleScript to send via Messages.app
And returns `true` on success

#### Scenario: iMessage on Linux
Given the platform is not macOS
When `imessage::send("recipient", "message")` is called
Then it returns `false` without error

### Requirement: Error classification in tts_elevenlabs
The system MUST move `classify_elevenlabs_error` and `ElevenLabsErrorCategory` to `tts_elevenlabs.rs`.

#### Scenario: Quota exhausted classification
Given an error string containing "quota_exceeded"
When `ElevenLabsClient::classify_error(error)` is called
Then it returns label "quota exhausted" and action "Top up credits to restore voice."

#### Scenario: Unknown error classification
Given an error string with no recognized pattern
When `ElevenLabsClient::classify_error(error)` is called
Then it returns label "unavailable" and action "Check logs for details."

## MODIFIED Requirements

### Requirement: Module declarations in mod.rs
The system MUST update `mod.rs` to declare new modules (`desktop`, `watch`, `imessage`) and add re-exports.

#### Scenario: New modules compile
When `cargo build -p nexus-agent` is run
Then all new modules are found and compile without errors
And all existing public re-exports in `mod.rs` continue to resolve

### Requirement: Caller updates
All callers of extracted functions MUST update their call sites to use new module paths.

#### Scenario: http_router calls updated
Given `http_router.rs` calls `Self::probe_audio_health()`, `Self::deliver_to_watch(...)`, `Self::play_audio_file(...)`, `Self::send_imessage(...)`
When the extraction is complete
Then all calls route through the new module functions (not `impl ReceiverService` methods)

#### Scenario: playback_queue calls updated
Given `playback_queue.rs` calls `ReceiverService::process_speak_request(...)` and `ReceiverService::send_imessage(...)`
When the extraction is complete
Then `send_imessage` calls route through `imessage::send`
And `process_speak_request` remains on `ReceiverService` (orchestrator)
