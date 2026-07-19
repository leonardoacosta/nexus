---
order: 0719d
---

# Proposal: Extract notification channel transports from router.ts

## Change ID
`extract-notification-channels`

## Summary
Split the TTS/ElevenLabs and Telegram channel-transport implementations out of
`apps/agent/src/notifications/router.ts` into dedicated channel modules with one shared
encrypted-credential resolver, and delete the dead serial `routeNotification` dispatch path.

## Context
- Extends: `apps/agent/src/notifications/router.ts`, `apps/agent/src/notifications/manager.ts`
- Related: `improve:code` lens findings GOD-04 (medium, M) and GOD-03 (low, S), adversarially
  confirmed at base commit `c25cd89d` — no drift on `router.ts`/`manager.ts` since that commit.
- touches: `apps/agent/src/notifications/router.ts`, `apps/agent/src/notifications/manager.ts`, `apps/agent/src/notifications/channels/tts.ts`, `apps/agent/src/notifications/channels/telegram.ts`

## Motivation
`router.ts` is 785 lines and mixes routing POLICY (rule matching, unspeakable-body
suppression, dispatch fan-out, timeout/error handling) with two full channel-transport
implementations: TTS/ElevenLabs (lines 58-322) and Telegram (lines 323-416). Each carries its
own ~40-line credential-resolution block with structurally identical
DB-row -> tryLoadEncryptionKey -> decrypt -> warn-and-fall-back-to-env scaffolding
(`resolveElevenLabsCredential` at 82-116 vs the inline Telegram block at 334-378) — GOD-04
(medium, M).

Separately, lines 596-630 hold a dead duplicate dispatch path: the serial `routeNotification`
("preserved for backward compat") has ZERO live (production) callers — the only non-test
reference is an unused import at `manager.ts:20` — yet it duplicates rule-matching,
unspeakable-strip, and missing-handler logic that `routeNotificationParallel` already
implements, so the two paths can silently drift — GOD-03 (low, S).

## Requirements

### Requirement: Channel transports move to dedicated modules
`apps/agent/src/notifications/channels/tts.ts` holds the ElevenLabs TTS handler (voice
resolution, synthesis, credential resolution). `apps/agent/src/notifications/channels/
telegram.ts` holds the Telegram Bot API handler (credential resolution, `sendMessage` call).
Both channels use one shared encrypted-credential resolver instead of duplicating the
DB-row -> key-load -> decrypt -> warn-and-fallback scaffold.

### Requirement: router.ts is pure routing policy
After extraction, `router.ts` contains only: rule matching (`findMatchingRule`,
`getRoutingRules`, `setRoutingRules`), unspeakable-body suppression, the `CHANNEL_HANDLERS`
dispatch map (importing the two channel handlers), `withChannelTimeout`, presence-aware
routing (`decidePresenceRoute`, `actionToChannels`), and `routeNotificationParallel`. It
re-exports `setTtsDbHandle` and `resolveElevenLabsCredential` so `server.ts` and
`tts-credential-resolve.test.ts` (outside this proposal's `- touches:` list) need no changes.

### Requirement: Dead serial dispatch path is removed
`routeNotification` (serial) and its unique logic are deleted from `router.ts`. The unused
import in `manager.ts:20` is removed. `routeNotificationParallel` remains the single dispatch
path.

## Scope
- **IN**: extracting TTS + Telegram channel handlers into `channels/tts.ts` and
  `channels/telegram.ts`; one shared credential-resolution helper; deleting `routeNotification`
  + its unused import in `manager.ts`; updating/removing tests that exclusively exercised the
  deleted serial path.
- **OUT**: any change to TTS/Telegram runtime behavior, credential precedence, or log
  semantics observable outside the module boundary; any change to `routeNotificationParallel`'s
  public contract; any change to `server.ts` or other external callers.

## Done Means
- TTS and Telegram dispatch behave identically at runtime (same credential precedence, same
  fail-open degradation, same re-query-per-dispatch — no cache — behavior).
- A rotated ElevenLabs or Telegram credential in the DB takes effect on the very next
  notification dispatch, with no agent restart.
- `router.ts` contains routing policy only — no channel-transport implementation code.
- `routeNotification` (serial) no longer exists anywhere in the notifications module or its
  callers.

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| TTS channel handler (`channels/tts.ts`) | `[1.1]`, `[1.4]` | N/A — no user-facing flow, existing `bun test` coverage (`tts-credential-resolve.test.ts`, `reliability-regression.test.ts`) is the verification surface |
| Telegram channel handler (`channels/telegram.ts`) | `[1.2]`, `[1.4]` | N/A — no user-facing flow |
| Shared credential resolver | `[1.1]`, `[1.2]` | N/A |
| Dead `routeNotification` removal (`router.ts`, `manager.ts`) | `[1.3]`, `[1.4]` | N/A |

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/notifications/router.ts` | Shrinks from 785 lines to routing-policy only; removes `routeNotification` |
| `apps/agent/src/notifications/manager.ts` | Removes unused `routeNotification` import |
| `apps/agent/src/notifications/channels/tts.ts` | New file — ElevenLabs TTS channel handler |
| `apps/agent/src/notifications/channels/telegram.ts` | New file — Telegram Bot API channel handler |
| `apps/agent/src/notifications/*.test.ts` | Tests exclusively exercising `routeNotification` updated to exercise `routeNotificationParallel`, or removed where redundant |

## Risks
| Risk | Mitigation |
|------|-----------|
| Credential resolution behavior drifts subtly during extraction (e.g. re-introduces caching) | Preserve the re-query-per-dispatch (no cache) comment/behavior verbatim in the shared resolver; `bun test` gate on `tts-credential-resolve.test.ts` before/after |
| Deleting `routeNotification` tests loses coverage of unknown-channel / timeout behavior | Convert coverage to `routeNotificationParallel` equivalents rather than bare deletion wherever the same behavior isn't already covered by an existing parallel-path test |
| `server.ts` breaks because `setTtsDbHandle` import path changes | `router.ts` re-exports `setTtsDbHandle` from the new channel module — `server.ts` import path (`./notifications/router`) is unchanged |
