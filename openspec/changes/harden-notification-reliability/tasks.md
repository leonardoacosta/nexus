## 1. Rust Receiver — Request and Socket Timeouts (P1)

- [ ] 1.1 In `service.rs::handle_request`, wrap the inner dispatch call with
      `tokio::time::timeout(Duration::from_secs(5), ...)` and return a 504 JSON error on
      `Elapsed`.
- [ ] 1.2 In `service.rs::speak_from_socket`, wrap the HTTP call with
      `tokio::time::timeout(Duration::from_secs(5), ...)` and return `Err(Elapsed)` on
      timeout.
- [ ] 1.3 Add unit tests: timeout returns 504 for `handle_request`; `speak_from_socket`
      returns `Err` when the mock server delays > 5 s.

## 2. TTS Retry with Exponential Backoff (P2)

- [ ] 2.1 Introduce a `retry_with_backoff` helper (or use `tokio-retry`) in
      `notification_engine.rs` with: 3 max attempts, base delay 500 ms, max delay 4 s,
      ±10 % jitter.
- [ ] 2.2 Apply the helper to the TTS delivery call at `notification_engine.rs:296`.
- [ ] 2.3 Log each retry attempt at `WARN` level with attempt number and delay.
- [ ] 2.4 Test: verify 3 attempts are made and the final error is propagated after all
      retries exhaust.

## 3. Config Reload Guard (P2)

- [ ] 3.1 In `notification_engine.rs` config reload handler (line 127), parse the new config
      into a temporary value first.
- [ ] 3.2 If parsing fails, log `ERROR` with the redacted error and retain the previous
      valid config without applying the new value.
- [ ] 3.3 If parsing succeeds, atomically swap the live config reference.
- [ ] 3.4 Test: supply an invalid config file during reload; assert the engine continues
      serving requests with the previous config.

## 4. Parallel Channel Delivery and Partial Success (P2)

- [ ] 4.1 Refactor `manager.ts:76` delivery loop to collect channel promises and execute
      via `Promise.allSettled`.
- [ ] 4.2 After settlement, collect fulfilled and rejected results separately.
- [ ] 4.3 Return a `{ delivered: string[]; failed: string[] }` result so callers can
      distinguish partial success from total failure.
- [ ] 4.4 Ensure a single channel throwing does not cause other channels to be skipped
      (line 89 behavior change).
- [ ] 4.5 Test: mock 3 channels where channel 2 throws; assert channels 1 and 3 deliver
      and the result carries `failed: ["channel2"]`.

## 5. Thread-Safe Singleton Reset (P2)

- [ ] 5.1 In `notifications.ts:10`, replace bare module-level singleton with an
      `AsyncMutex`-guarded reference (or equivalent Bun-safe pattern).
- [ ] 5.2 All `reset()` and `getInstance()` callers MUST acquire the lock before
      reading or writing the singleton reference.
- [ ] 5.3 Test: concurrent `reset()` calls from multiple async tasks produce no torn state.

## 6. PII Redaction in Error Logging (P3)

- [ ] 6.1 Implement a `redact(msg: &str) -> String` helper in `notification_engine.rs`
      that strips email addresses, URLs, and filesystem paths from log strings.
- [ ] 6.2 Apply `redact()` at `notification_engine.rs:203` and all other error log sites
      in the same file.
- [ ] 6.3 Test: a message containing an email address is logged without the address.

## 7. Notification Struct Validation (P3)

- [ ] 7.1 Add validation in `notification_engine.rs:136` (or at the route handler before
      passing to the engine): reject payloads where `message` is empty or exceeds 500
      characters.
- [ ] 7.2 Return HTTP 400 with a structured `{ error: "validation", detail: "..." }`
      body for invalid payloads.
- [ ] 7.3 Test: empty message returns 400; 501-char message returns 400; 500-char
      message returns 200.

## 8. Buffer Metadata Persistence (P3)

- [ ] 8.1 In `buffer.ts:13`, serialize buffer metadata (counts, watermarks, last-flush
      timestamp) to a JSON sidecar file on each mutation.
- [ ] 8.2 On startup, read the sidecar if present and hydrate the in-memory state.
- [ ] 8.3 Test: write metadata, simulate restart by re-creating the buffer instance,
      assert hydrated state matches persisted values.

## 9. Duplicate Notification Suppression (P3)

- [ ] 9.1 In `routes/notifications.ts:73`, compute `hash(message + target)` for each
      incoming notification.
- [ ] 9.2 Check the hash against an in-memory `Map<hash, timestamp>` with a 5-second TTL.
- [ ] 9.3 If hash is present and within TTL, return 200 with `{ suppressed: true }` without
      re-delivering.
- [ ] 9.4 Evict expired entries on each lookup (or on a periodic 30-second sweep).
- [ ] 9.5 Test: same message + target within 5 s is suppressed; after 5 s the same message
      is delivered again.

## 10. Integration Validation

- [ ] 10.1 Run `cargo clippy -p nexus-agent -- -D warnings` — zero new warnings.
- [ ] 10.2 Run `cargo test -p nexus-agent` — all tests pass.
- [ ] 10.3 Run `bun test` in `apps/agent` — all tests pass (set `NEXUS_ATTACH_SECRET=test`).
- [ ] 10.4 Manual smoke test: send 2 identical notifications within 5 s and confirm only
      one TTS plays; send a notification with a 600-char message and confirm 400 response.
