---
order: 0724g
---

# Proposal: Direct Regression Tests for TTS Degradation + Voice-ID Cap; Delete Dead Skip Placeholders

## Change ID
`tts-degradation-test-coverage`

> Advisor stamp: 2026-07-24 `/improve` run against commit `9e4963b9`. Verify cited lines before starting; STOP on drift.

## Summary
Three test-hygiene gaps in `apps/agent`, one change: (a) the TTS channel's deliberate degradation contract — synth failure must never drop the notification — has no direct tests (`channels/tts.test.ts` holds 3 happy-path cases only; the branches at `tts.ts:~244-245` ElevenLabs HTTP error → caught → signal-only at `:~303`, no-credential → signal-only at `:~291`, voice-resolution throw caught at `:~197` are all unasserted); (b) the `VOICE_ID_MAX` over-length 400 at `routes/notifications-voices.ts:84` has zero coverage; (c) `notifications/notifications.test.ts:31,92` carry two unconditional `describe.skip` blocks whose 11 bodies are all `expect(true).toBe(true)` — the named behaviors are actually covered in `buffer.test.ts`, `manager.integration.test.ts`, `held-queue.test.ts`, `rules-engine.test.ts`, so the placeholders are misleading scaffolding.

## Context
- depends on:
- touches: `apps/agent/src/notifications/channels/tts.test.ts`, `apps/agent/src/routes/notifications-voices.test.ts`, `apps/agent/src/notifications/notifications.test.ts`

## Motivation
Found by the 2026-07-24 advisor audit (test coverage, HIGH confidence). `reliability-regression.test.ts:242` covers router-level hung-TTS (failed channel, desktop still delivered) but not the channel's internal degrade-to-signal-only contract — `tts.ts`'s own comment at `:216` names it as the intended behavior. A refactor could turn a synth 5xx into a lost notification undetected. Placeholder-deletion precedent: `db.test.ts:252` ("Previously a `describe.skip` placeholder. Un-stubbed…").

## Testing
This proposal IS tests. Mechanics: follow `tts.test.ts`'s own established mock pattern (header comment; `mock.module` spread-the-real-barrel per nx-jlx1c; `globalThis.fetch` stub; `NEXUS_CONFIG_DIR` to a tmp dir). New cases: fetch→500 ⇒ notification delivered signal-only (`audioBase64` absent, no throw); no credential row ⇒ signal-only; voice-resolution throw ⇒ signal-only. Voices route: over-`VOICE_ID_MAX` id ⇒ 400 naming the cap (exemplar: the empty-voice_id case at `notifications-voices.test.ts:142`). PG-backed suites run under `NEXUS_PG_TESTS=1` + `POSTGRES_URL` per `testing/live-pg.ts`.

## Done Means
- Each degradation branch in `tts.ts` has a direct assertion that the notification still delivers signal-only.
- The `VOICE_ID_MAX` cap regression-tested at the route.
- Zero `expect(true)` placeholders remain in `notifications.test.ts`; no named-but-empty suites.

## Scope
- **IN**: the three test files above.
- **OUT**: `tts.ts` production code (behavior unchanged — if a test reveals the contract does NOT hold, STOP and report; that becomes a bug proposal, not a silent fix here); `reliability-regression.test.ts`; Swift tests.
