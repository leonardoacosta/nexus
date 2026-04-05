# Proposal

## Change ID

fix-notification-engine-reliability

## Summary

Harden the notification engine against delivery failures, unbounded growth, and silent data corruption by adding return-value propagation, timeouts, buffer caps, state-machine guards, Sentry capture, and diagnostic logging across the Rust and TypeScript notification paths.

## Context

The notification engine spans two runtimes: a Rust `speak_from_socket` path in `crates/nexus-agent/src/services/receiver/service.rs` and a TypeScript dispatch layer in `apps/agent/src/notifications/`. A post-deployment audit (epic nx-lxbs) identified eight reliability gaps across both layers — two P1 bugs that silently drop delivery errors, three P2 correctness issues, and three P3 observability gaps.

## Motivation

- `speak_from_socket()` returns `void`, so callers cannot distinguish a successful TTS delivery from a silently swallowed HTTP error (nx-5ti3).
- No timeout on the TTS HTTP call means the engine blocks indefinitely when the upstream API hangs (nx-t7ss).
- The notification buffer grows without bound under high throughput, risking OOM on long-running agents (nx-s0sg).
- The meeting state machine accepts `start`/`end` calls in any state, allowing impossible transitions that corrupt meeting context (nx-zncj).
- Delivery failures in TS channels are swallowed without Sentry capture, making debugging impossible in production (nx-widy).
- Unknown channel handlers are skipped silently — no operator log, no way to detect misconfiguration (nx-y035).
- Sentry breadcrumbs are written before delivery completes, so partial failures appear as successes (nx-4ysk).
- Notification struct fields are not validated before delivery, allowing malformed payloads to propagate (nx-aoyo).

## Requirements

### Req-1: speak_from_socket Returns Result with Timeout

`speak_from_socket()` in `service.rs:73-112` SHALL return `Result<bool>` instead of `void`. The HTTP call to the TTS API SHALL be wrapped in a 5-second timeout. On timeout or HTTP error the function SHALL return `Err(...)` and capture the error to Sentry. Callers SHALL propagate or log the returned error.

#### Scenario: Successful delivery returns Ok(true)
- **WHEN** the TTS API responds with HTTP 200
- **THEN** `speak_from_socket()` returns `Ok(true)` and the caller logs success

#### Scenario: HTTP error returns Err and captures to Sentry
- **WHEN** the TTS API responds with HTTP 500
- **THEN** `speak_from_socket()` returns `Err(...)`, the error is captured to Sentry, and the caller receives the error

#### Scenario: Timeout returns Err and captures to Sentry
- **WHEN** the TTS API does not respond within 5 seconds
- **THEN** `speak_from_socket()` returns `Err(timeout)`, the error is captured to Sentry, and the blocking call is cancelled

### Req-2: Bounded Notification Buffer

The notification buffer in `buffer.ts:10-12` SHALL enforce a maximum capacity of `MAX_BUFFER_SIZE = 1000` entries. When the buffer is at capacity and a new notification arrives, the oldest entry SHALL be evicted (LRU) before the new entry is inserted.

#### Scenario: Buffer at capacity evicts oldest entry
- **WHEN** the buffer holds 1000 notifications and a new one arrives
- **THEN** the oldest notification is removed and the new one is appended, keeping the size at 1000

#### Scenario: Buffer below capacity accepts new entries
- **WHEN** the buffer holds fewer than 1000 notifications
- **THEN** the new notification is appended without eviction

### Req-3: Meeting State Machine Transition Guards

The meeting state machine in `meeting-state.ts:1-32` SHALL enforce valid state transitions. Calling `start()` while a meeting is already active, or calling `end()` when no meeting is active, SHALL throw an `InvalidStateError`. All other valid transitions SHALL proceed unchanged.

#### Scenario: start() rejected when meeting already active
- **WHEN** the state machine is in the `active` state and `start()` is called
- **THEN** an `InvalidStateError` is thrown with message indicating invalid transition

#### Scenario: end() rejected when no meeting is active
- **WHEN** the state machine is in the `idle` state and `end()` is called
- **THEN** an `InvalidStateError` is thrown with message indicating invalid transition

#### Scenario: Valid start transition accepted
- **WHEN** the state machine is in the `idle` state and `start()` is called
- **THEN** the state transitions to `active` without error

### Req-4: Sentry Capture in TypeScript Delivery Channels

Each delivery channel (`channels/desktop.ts`, `channels/tts.ts`, `channels/slack.ts`) SHALL wrap its send logic in a try/catch block. On error, the catch block SHALL call `captureException(err)` before re-throwing or returning a failure result. Errors SHALL NOT be silently swallowed.

#### Scenario: Desktop channel captures delivery error
- **WHEN** the desktop notification API throws an error
- **THEN** `captureException(err)` is called and the error is propagated to the caller

#### Scenario: TTS channel captures delivery error
- **WHEN** the TTS HTTP call fails
- **THEN** `captureException(err)` is called and the error is propagated to the caller

#### Scenario: Slack channel captures delivery error
- **WHEN** the Slack API returns an error response
- **THEN** `captureException(err)` is called and the error is propagated to the caller

### Req-5: Logged Unknown Channel Dispatch

The channel router in `router.ts:64-70` SHALL emit a `logger.warn` log line when a notification is dispatched to a channel name for which no handler is registered. The log line SHALL include the unknown channel name and the notification ID. The notification SHALL be skipped without throwing.

#### Scenario: Unknown channel emits warn log
- **WHEN** a notification targets a channel name not present in the handler registry
- **THEN** `logger.warn` is called with the channel name and notification ID, and dispatch continues to other channels

#### Scenario: Known channel dispatches normally
- **WHEN** a notification targets a registered channel name
- **THEN** the handler is invoked without any warn log

## Scope

**In scope:**
- `crates/nexus-agent/src/services/receiver/service.rs` (Req-1)
- `apps/agent/src/notifications/buffer.ts` (Req-2)
- `apps/agent/src/notifications/meeting-state.ts` (Req-3)
- `apps/agent/src/notifications/channels/desktop.ts` (Req-4)
- `apps/agent/src/notifications/channels/tts.ts` (Req-4)
- `apps/agent/src/notifications/channels/slack.ts` (Req-4)
- `apps/agent/src/notifications/router.ts` (Req-5)

**Out of scope (tracked separately):**
- nx-4ysk: Sentry breadcrumb ordering in `notification_engine.rs:303-312`
- nx-aoyo: Notification struct field validation in `notification_engine.rs:136-140`

## Impact

- **Affected specs:** `notification-engine` (new delta), `observability-stack` (existing Sentry breadcrumb requirement is context)
- **Affected code:** Rust receiver service, TypeScript notification buffer, meeting state machine, all three TS delivery channels, TS channel router
- **Runtime impact:** 5s timeout on TTS calls prevents indefinite blocking; LRU eviction prevents OOM; no observable behavioral change under normal load

## Risks

- **Timeout too aggressive:** 5s may be too short for slow TTS APIs on the Mac notifier. Mitigated by making `SPEAK_TIMEOUT_MS` an env-configurable constant defaulting to 5000.
- **LRU eviction drops notifications:** Under sustained high throughput, notifications older than the buffer window are silently dropped. Mitigated by emitting a `logger.warn` when eviction occurs, making drops visible in logs.
- **State machine guard introduces breaking change:** Callers that currently rely on idempotent `start()`/`end()` calls will need to guard calls with state checks. All internal callers are within `apps/agent` and can be updated atomically.
