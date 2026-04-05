## 1. API Batch (Rust): speak_from_socket Result type + timeout

- [ ] 1.1 Change `speak_from_socket()` signature from `-> ()` to `-> anyhow::Result<bool>` in `service.rs:73`
- [ ] 1.2 Wrap the TTS HTTP call in `tokio::time::timeout(Duration::from_millis(SPEAK_TIMEOUT_MS), ...)` with `SPEAK_TIMEOUT_MS` defaulting to 5000 and configurable via env var
- [ ] 1.3 On timeout error: call `sentry::capture_error(&err)` and return `Err(err.into())`
- [ ] 1.4 On HTTP non-2xx response: call `sentry::capture_message(...)` and return `Err(...)`
- [ ] 1.5 On success: return `Ok(true)`
- [ ] 1.6 Update all callers of `speak_from_socket()` in `service.rs` to propagate or log the returned `Result`

## 2. API Batch (TypeScript): buffer cap, state machine guards, Sentry in channels, router warn

- [ ] 2.1 Add `MAX_BUFFER_SIZE = 1000` constant to `buffer.ts`
- [ ] 2.2 Implement LRU eviction in the buffer insert path: when `buffer.length >= MAX_BUFFER_SIZE`, call `buffer.shift()` before pushing, and emit `logger.warn("notification buffer eviction", { dropped: id })`
- [ ] 2.3 Define `InvalidStateError` class in `meeting-state.ts` (extends `Error`)
- [ ] 2.4 Add guard to `start()`: throw `InvalidStateError("cannot start: meeting already active")` if state is `active`
- [ ] 2.5 Add guard to `end()`: throw `InvalidStateError("cannot end: no meeting active")` if state is `idle`
- [ ] 2.6 Wrap send logic in `channels/desktop.ts` in try/catch; call `captureException(err)` in catch before re-throwing
- [ ] 2.7 Wrap send logic in `channels/tts.ts` in try/catch; call `captureException(err)` in catch before re-throwing
- [ ] 2.8 Wrap send logic in `channels/slack.ts` in try/catch; call `captureException(err)` in catch before re-throwing
- [ ] 2.9 In `router.ts:64-70`, after handler lookup, if handler is `undefined` emit `logger.warn("unknown notification channel", { channel, notificationId })` and skip — do not throw
