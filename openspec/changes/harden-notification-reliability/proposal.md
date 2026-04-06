# Change: Harden Notification Reliability

## Why

The 2026-04-06 platform audit surfaced twelve findings across the notification subsystem
ranging from P1 indefinite blocks in the Rust receiver service to P2 serial delivery
bottlenecks and thread-safety gaps in the TypeScript notification manager. Left unresolved,
a single slow TTS call can freeze the entire notification engine, and a concurrent reset of
the singleton manager can produce torn state under flush pressure.

## What Changes

- **BREAKING (P1):** Wrap `ReceiverService::handle_request` in a 5-second
  `tokio::time::timeout`; a hung handler can no longer block all other notifications.
- **BREAKING (P1):** Wrap `ReceiverService::speak_from_socket` in a 5-second
  `tokio::time::timeout`; this is distinct from the per-request timeout and applies to the
  raw socket-based speak path.
- **(P2):** Add exponential-backoff retry (3 attempts, base 500 ms, max 4 s, ±10 % jitter)
  to the TTS delivery path in `notification_engine.rs`.
- **(P2):** Config reload in `notification_engine.rs` MUST validate the new config before
  applying it; on parse error the previous valid config is retained and the error is logged.
- **(P2):** Convert serial channel delivery in `manager.ts` to `Promise.all` with per-channel
  error isolation so a single failing channel does not block or suppress others.
- **(P2):** Partial channel delivery (some channels succeed, some fail) MUST be reported as
  partial success, not complete failure.
- **(P2):** `NotificationManager` singleton reset in `notifications.ts` MUST be made
  thread-safe (mutex-guarded or using an atomic swap pattern).
- **(P3):** Error messages logged in `notification_engine.rs` MUST be passed through a
  `redact()` helper to strip PII before writing to the log.
- **(P3):** Incoming `Notification` structs MUST be validated: non-empty message, max 500
  characters; invalid payloads are rejected with a 400 response.
- **(P3):** Buffer metadata in `buffer.ts` MUST be persisted to disk so restart does not
  lose in-flight state.
- **(P3):** Duplicate notifications (same `hash(message + target)` within 5 seconds) arriving
  at `routes/notifications.ts` MUST be suppressed without re-delivery.

## Impact

- Affected specs: `notification-store`, `receiver-router`
- Affected code:
  - `crates/nexus-agent/src/service.rs` (handle_request, speak_from_socket — lines 119+)
  - `apps/agent/src/notification_engine.rs` (retry, config reload — lines 127, 203, 296)
  - `apps/agent/src/manager.ts` (parallel delivery, partial success — lines 76, 89)
  - `apps/agent/src/notifications.ts` (singleton safety — line 10)
  - `apps/agent/src/buffer.ts` (metadata persistence — line 13)
  - `apps/agent/src/routes/notifications.ts` (dedup — line 73)
- No external API surface changes; all changes are internal to the agent daemon.
- Config reload behavior changes are observable via logs but not via HTTP responses.
