# Implementation Tasks

<!-- beads:epic:TBD -->

## DB Batch

(no database changes)

## API Batch

- [x] [2.1] [P-1] Add `static ELEVENLABS_ALERT_SENT: AtomicBool` to `delivery.rs` for session-scoped deduplication of failure alerts [owner:api-engineer]
- [x] [2.2] [P-1] In the ElevenLabs error branch of `process_speak_request`, extract error category from the API response (quota_exceeded, invalid_api_key, timeout, other) [owner:api-engineer]
- [x] [2.3] [P-2] On first failure (AtomicBool CAS false→true), call `show_notification` with degradation alert message including error category [owner:api-engineer]

## UI Batch

(no TUI changes)

## E2E Batch

- [ ] [4.1] Verify alert fires on first ElevenLabs failure by temporarily using invalid API key, confirm desktop notification appears [owner:user]
