# Implementation Tasks

<!-- beads:epic:nx-80xw -->

## Types Batch

- [x] [1.1] [P-1] Add `DeliveryResult` enum to `types.rs` with `Played { message, provider }`, `Skipped { reason }`, `Failed { error }` variants [owner:rust-engineer] [beads:nx-tt5b]
- [x] [1.2] [P-1] Move `ElevenLabsErrorCategory` and `classify_elevenlabs_error` to `tts_elevenlabs.rs` as `ElevenLabsClient::classify_error` [owner:rust-engineer] [beads:nx-74ay]

## Extraction Batch

- [x] [2.1] [P-1] Create `desktop.rs` — extract `show_notification` as free async fn; update `mod.rs` with module declaration and re-export [owner:rust-engineer] [beads:nx-89ec]
- [x] [2.2] [P-1] Move `play_audio_file` and `probe_audio_health` into `audio.rs` as free async fns alongside existing `AudioController` [owner:rust-engineer] [beads:nx-c2hd]
- [x] [2.3] [P-1] Create `watch.rs` — extract `deliver_to_watch`; add `WatchDeliveryConfig::try_from` to flatten the 4 sequential match guards [owner:rust-engineer] [beads:nx-6k4d]
- [x] [2.4] [P-1] Create `imessage.rs` — extract `send_imessage` (macOS + stub) as free async fn [owner:rust-engineer] [beads:nx-wfi5]

## Orchestrator Batch

- [x] [3.1] [P-1] Extract ElevenLabs synthesis path (lines 263-316) into `try_elevenlabs_tts` helper in `delivery.rs` [owner:rust-engineer] [beads:nx-0xkx]
- [x] [3.2] [P-1] Refactor `process_speak_request` to return `DeliveryResult`; flatten nesting with early returns for silent/system modes [owner:rust-engineer] [beads:nx-6ljr]
- [x] [3.3] [P-2] Remove extracted functions from `delivery.rs`; verify it is ~100-130 lines [owner:rust-engineer] [beads:nx-k5rc]

## Caller Update Batch

- [x] [4.1] [P-1] Update `http_router.rs` — replace `Self::probe_audio_health()`, `Self::deliver_to_watch(...)`, `Self::play_audio_file(...)`, `Self::send_imessage(...)` with new module paths [owner:rust-engineer] [beads:nx-tefg]
- [x] [4.2] [P-1] Update `playback_queue.rs` — replace tuple destructuring at lines 151, 240 with `DeliveryResult` match arms [owner:rust-engineer] [beads:nx-m901]
- [x] [4.3] [P-1] Update `service.rs` line 245 — replace `Self::show_notification(...)` with `desktop::show_notification(...)` [owner:rust-engineer] [beads:nx-x1m3]
- [x] [4.4] [P-2] Update `mod.rs` re-exports — add `desktop`, `watch`, `imessage` modules; export `DeliveryResult` [owner:rust-engineer] [beads:nx-ge1z]

## Validation Batch

- [ ] [5.1] `cargo build -p nexus-agent` compiles without errors [owner:rust-engineer] [beads:nx-svmt]
- [ ] [5.2] `cargo test -p nexus-agent` passes (existing tests, especially service_tests.rs iMessage tests) [owner:rust-engineer] [beads:nx-uahp]
- [ ] [5.3] `cargo clippy -p nexus-agent` passes with no new warnings [owner:rust-engineer] [beads:nx-rg64]
