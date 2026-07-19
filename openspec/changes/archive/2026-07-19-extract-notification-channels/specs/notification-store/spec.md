## ADDED Requirements

### Requirement: Notification channel transports live in dedicated modules

The notification router MUST delegate channel-specific transport logic (TTS/ElevenLabs
synthesis, Telegram Bot API delivery) to dedicated modules under
`apps/agent/src/notifications/channels/`, keeping `router.ts` limited to rule matching,
suppression, dispatch fan-out, and timeout/error handling.

#### Scenario: TTS transport is isolated from routing policy
- **WHEN** a notification is routed to the `tts` channel
- **THEN** ElevenLabs credential resolution, voice-id resolution, and the synthesis call
  execute inside `apps/agent/src/notifications/channels/tts.ts`, not `router.ts`

#### Scenario: Telegram transport is isolated from routing policy
- **WHEN** a notification is routed to the `telegram` channel
- **THEN** Telegram Bot API credential resolution and the `sendMessage` call execute inside
  `apps/agent/src/notifications/channels/telegram.ts`, not `router.ts`

### Requirement: Encrypted channel credentials share one resolver

TTS and Telegram MUST share a single encrypted-credential resolver implementation (DB row
lookup, decrypt, warn-and-fall-back to env) rather than duplicating the scaffold per channel,
and MUST re-query and re-decrypt on every dispatch (no in-memory cache), so a rotated
credential takes effect on the very next notification.

#### Scenario: Rotated credential takes effect without agent restart
- **WHEN** an operator rotates an encrypted channel credential in the database
- **THEN** the very next notification dispatched through that channel resolves the new
  credential value, with no agent restart required

### Requirement: Notification routing has a single dispatch path

The router MUST expose exactly one notification dispatch function
(`routeNotificationParallel`). The legacy serial `routeNotification` dispatch path MUST NOT
exist, so routing logic (rule matching, unspeakable-body suppression, missing-handler
surfacing) cannot drift between two duplicate implementations.

#### Scenario: No serial dispatch path remains
- **WHEN** the notifications module is inspected for exported dispatch functions
- **THEN** `routeNotification` (serial) is not exported by `router.ts`, and `manager.ts` does
  not import it
