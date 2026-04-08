# Proposal: Delivery Service Decomposition

## Change ID
`decompose-delivery-service`

## Summary
Split `delivery.rs` (578 lines, 8 functions mixing 5 remaining concerns) into focused modules
and replace the `(bool, Option<String>, Option<String>)` tuple return from `process_speak_request`
with a typed `DeliveryResult` enum.

## Context
- Extends: `crates/nexus-agent/src/services/receiver/delivery.rs` (all `impl ReceiverService` methods)
- Related: `harden-notification-reliability` (complete) focused on timeouts/retries, not structure
- Related: Prior audit wave found 7 concerns in delivery.rs; 2 (TTS orchestration, APNS client) are already extracted into `tts.rs`, `tts_elevenlabs.rs`, `tts_system.rs`, `apns.rs`, `audio.rs`

## Motivation
The 2026-04-06 audit identified `delivery.rs` as mixing 7 concerns. Since then, TTS orchestration
and APNS have been extracted, but 5 concerns remain tangled in a single 578-line file:
1. Desktop notifications (macOS terminal-notifier / Linux notify-send)
2. Audio playback (player discovery and file playback)
3. Audio health probing
4. Speak request orchestration (ElevenLabs -> system TTS fallback with chime, error alerts)
5. iMessage sending (macOS AppleScript)

`process_speak_request` is ~113 lines with 5 nesting levels and returns an untyped tuple
`(bool, Option<String>, Option<String>)` that callers must destructure by position. A typed
`DeliveryResult` enum would make success/failure/skip semantics explicit.

`deliver_to_watch` (162 lines) duplicates early-return config validation that could use a
builder or config-extraction helper, and should move to its own module since Watch delivery
is conceptually separate from desktop/TTS delivery.

## Requirements

### Req-1: Extract desktop notification module
Move `show_notification` to `desktop.rs` as a standalone async function (not an `impl ReceiverService` method). All callers update to use the free function.

### Req-2: Extract audio playback module
Move `play_audio_file` and `probe_audio_health` to the existing `audio.rs` or a new `playback.rs`. These are platform-specific audio utilities unrelated to TTS orchestration.

### Req-3: Extract Watch delivery module
Move `deliver_to_watch` to `watch.rs`. Extract the config validation chain (apns_key_path, apns_key_id, apns_team_id, bundle_id) into a validated config struct to flatten the 4 sequential `match` guards.

### Req-4: Extract iMessage module
Move `send_imessage` (both macOS and stub) to `imessage.rs` as a free function.

### Req-5: Replace tuple return with DeliveryResult enum
Replace `(bool, Option<String>, Option<String>)` with:
```rust
pub enum DeliveryResult {
    Played { message: String, provider: String },
    Skipped { reason: String },
    Failed { error: String },
}
```
Update all callers (`playback_queue.rs` destructuring at lines 151, 240).

### Req-6: Flatten process_speak_request nesting
Refactor `process_speak_request` to use early returns instead of nested if-let chains. The ElevenLabs path (lines 263-316) should be extracted to a helper method. Keep `process_speak_request` in `delivery.rs` as the thin orchestrator that dispatches to the extracted modules.

### Req-7: Extract error classification
Move `classify_elevenlabs_error` and `ElevenLabsErrorCategory` to `tts_elevenlabs.rs` where they logically belong (ElevenLabs-specific error handling).

## Scope
- **IN**: Splitting delivery.rs into desktop.rs, watch.rs, imessage.rs; moving functions to existing audio.rs/tts_elevenlabs.rs; DeliveryResult enum; flattening process_speak_request; updating all callers
- **OUT**: Changing notification behavior or adding features; modifying the TTS orchestrator (tts.rs); changing APNS protocol (apns.rs); modifying the playback queue logic beyond DeliveryResult adoption

## Impact
| Area | Change |
|------|--------|
| `delivery.rs` | Shrinks from 578 to ~130 lines (orchestrator only) |
| `desktop.rs` | New file (~70 lines) |
| `watch.rs` | New file (~170 lines) |
| `imessage.rs` | New file (~45 lines) |
| `audio.rs` | Gains `play_audio_file` + `probe_audio_health` (~90 lines) |
| `tts_elevenlabs.rs` | Gains `classify_elevenlabs_error` + `ElevenLabsErrorCategory` (~35 lines) |
| `playback_queue.rs` | Update destructuring to use `DeliveryResult` match |
| `http_router.rs` | Update direct calls to use new module paths |
| `mod.rs` | Add new module declarations and re-exports |
| `types.rs` | Add `DeliveryResult` enum |

## Risks
| Risk | Mitigation |
|------|-----------|
| Callers break during migration | All callers identified (http_router.rs, playback_queue.rs, service.rs); update in same commit |
| `cfg(target_os)` conditionals scatter across modules | Each platform-specific module owns its own cfg gates; no cross-module cfg leakage |
| `ELEVENLABS_ALERT_SENT` static moves with error classification | Keep the static in delivery.rs (orchestrator) since it gates orchestration behavior, not error classification |
| Watch config validation struct adds complexity | Use a simple `WatchDeliveryConfig::try_from` that returns `Option` — no over-engineering |
