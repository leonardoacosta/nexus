---
order: 0720c
---

# Proposal: Provider-Qualified Project Voices

## Change ID
`provider-qualified-project-voices`

## Why

With two synthesis providers live (`swift-tts-provider-chain`), the per-project voice map is
the last ElevenLabs-shaped surface: `project_voice_overrides.voice_id` holds bare ElevenLabs
UUIDs, the agent pre-render assumes every override is an ElevenLabs voice, and the Mac
listener applies overrides only to its ElevenLabs attempt. Projects can't say "speak nx in
`kokoro:af_heart`". A qualified-string convention closes that gap with zero schema migration.

## What Changes

- Voice id convention: `provider:voice` (e.g. `kokoro:af_heart`,
  `elevenlabs:21m00Tcm4TlvDq8ikWAM`). Bare values remain valid and mean `elevenlabs` —
  existing rows need no migration.
- `@nexus/core` gains `parseQualifiedVoice(id)` → `{ provider, voice }` shared by agent and
  (as a mirrored Swift helper) NexusShared.
- `PUT /notifications/voices/:project` validates the prefix against known TTS providers
  (`elevenlabs` + registry providers); unknown prefixes → 400.
- Agent TTS pre-render (`channels/tts.ts`): a kokoro-qualified resolved voice skips the
  ElevenLabs call and emits `NotificationFired` signal-only (`audioBase64` absent) — the Mac
  listener owns Kokoro synthesis; the agent stays headless.
- Swift `TTSObserver`: a qualified project override routes synthesis to the matching
  provider in the chain (kokoro-qualified → `KokoroClient` with that voice; bare or
  elevenlabs-qualified → today's behavior).
- Generic voice listing: `ProviderDescriptor` gains optional
  `listVoices(secret, metadata)`; `GET /integrations/:provider/voices` returns its result or
  404 when the descriptor lacks it. Kokoro implements via `GET {baseUrl}/v1/audio/voices`.
  The bespoke `elevenlabs-voices.ts` proxy is untouched.

## Context

- depends on: `add-kokoro-integration-provider`, `swift-tts-provider-chain`
- touches: `packages/core/src/types/integrations.ts`, `packages/db/src/schema/projectVoiceOverrides.ts`, `apps/agent/src/integrations/registry.ts`, `apps/agent/src/routes/integration-credentials.ts`, `apps/agent/src/server-request-handler.ts`, `apps/agent/src/routes/notifications-voices.ts`, `apps/agent/src/notifications/channels/tts.ts`, `apps/swift/NexusShared/Observers/TTSObserver.swift`, `apps/swift/NexusSharedTests`

- Extends: the `SpeechProvider` chain landed by `swift-tts-provider-chain`
- Extends: the `kokoro` descriptor landed by `add-kokoro-integration-provider`
- Related: `elevenlabs-voices.ts` + capability `elevenlabs-credential` (NOT modified — the
  bespoke ElevenLabs voice proxy survives until a future consolidation proposal)

## Impact

- Affected specs: `integration-registry` (ADDED: optional generic voice listing),
  `notification-store` (MODIFIED: TTS pre-render honors non-ElevenLabs qualified voices),
  `mac-tts-listener` (ADDED: qualified overrides route to the matching provider)
- Affected code: voice parsing helper, one route validation, one pre-render branch, one
  observer routing branch, descriptor + voices endpoint. No DB migration —
  `project_voice_overrides.voice_id` stores the qualified string in place (schema doc
  comment updated).

## Done Means

- Operator can `PUT /notifications/voices/nx {"voice_id":"kokoro:af_heart"}` and the next nx
  notification is spoken by Kokoro in `af_heart`, while other projects keep their ElevenLabs
  voices.
- Existing bare-UUID rows keep working with zero migration or re-save.
- `PUT` with `voice_id: "nope:xyz"` returns 400 and writes nothing.
- `GET /integrations/kokoro/voices` returns the live Kokoro voice list;
  `GET /integrations/telegram/voices` returns 404.

## Testing

- Unit (agent): `parseQualifiedVoice` (bare, qualified, unknown-prefix); PUT validation
  accept/reject matrix; `tts.ts` skips ElevenLabs and emits signal-only for
  kokoro-qualified voices; generic voices route (kokoro proxies, telegram 404s) (tasks 4.1,
  4.2).
- Unit (`NexusSharedTests`): qualified override routes the stubbed provider chain to Kokoro
  with the parsed voice; bare override still hits the ElevenLabs attempt (task 4.3).
- E2E: N/A — no web UI consumes voice overrides today (verified: no `apps/web` references);
  the REST + observer unit layers cover the full path.
