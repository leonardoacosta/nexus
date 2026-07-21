---
stack: t3
---

# Tasks: Provider-Qualified Project Voices

## DB Batch

- [x] [1.1] [P-3] Update the doc comment on `packages/db/src/schema/projectVoiceOverrides.ts` `voiceId`: value is now a qualified `provider:voice` string (bare = `elevenlabs` for backward compat). No migration — column type unchanged. [owner:db-engineer] [type:docs]

## API Batch

- [x] [2.1] [P-2] Add `parseQualifiedVoice(id: string): { provider: string; voice: string }` to `packages/core/src/types/integrations.ts` — splits on the first `:`; no separator → `{ provider: "elevenlabs", voice: id }`; export from `packages/core/src/index.ts`. Export a `TTS_VOICE_PROVIDERS` set (`"elevenlabs"` + the TTS-capable registry providers, currently `"kokoro"`). [owner:api-engineer] [type:api]
- [x] [2.2] [P-2] In `apps/agent/src/routes/notifications-voices.ts` PUT handler, validate `voice_id` with `parseQualifiedVoice` against `TTS_VOICE_PROVIDERS`; unknown prefix → 400 with the allowed provider list, no write. Bare ids stay valid. [owner:api-engineer] [type:api]
- [x] [2.3] [P-2] In `apps/agent/src/notifications/channels/tts.ts`, run the resolved voice through `parseQualifiedVoice`: provider `elevenlabs` → existing pre-render unchanged (pass the bare voice to the API call); any other provider → skip synthesis and emit `NotificationFired` signal-only (`audioBase64` absent), logging the provider at debug. [owner:api-engineer] [type:api]
- [x] [2.4] [P-2] Add optional `listVoices?(secret, metadata) => Promise<{ ok: boolean; statusCode: number | null; voices: unknown[] }>` to `ProviderDescriptor` (`apps/agent/src/integrations/registry.ts`); implement for `kokoro` via `GET {metadata.baseUrl}/v1/audio/voices` (5s timeout, never throws). Add `GET /integrations/:provider/voices` to the generic route group (`apps/agent/src/routes/integration-credentials.ts` + registration in `apps/agent/src/server-request-handler.ts` if the subpath needs it): descriptor without `listVoices` → 404; no stored row for a provider whose probe needs metadata → 400. [owner:api-engineer] [type:api]

## UI Batch

- [x] [3.1] [P-2] In `apps/swift/NexusShared/Observers/TTSObserver.swift`, mirror `parseQualifiedVoice` (small pure helper in NexusShared) and route a qualified project override to the matching provider in the chain: `kokoro:` → the Kokoro attempt uses the parsed voice (overriding `settings.kokoroVoice`); `elevenlabs:` or bare → today's ElevenLabs resolution unchanged; unknown prefix → log + treat as no override. [owner:ui-engineer] [type:ui]
- [x] [3.2] [P-3] Typecheck gate: from Linux, run the headless Mac typecheck (`ssh mac` + `swiftc -typecheck` over NexusShared sources per the swift-engineer contract) and paste passing output; zero errors. [owner:ui-engineer] [type:ui]

## E2E Batch

- [x] [4.1] Unit tests (agent): `parseQualifiedVoice` bare/qualified/unknown matrix; PUT `/notifications/voices/:project` accepts `kokoro:af_heart` and bare UUIDs, 400s `nope:xyz` without writing; `tts.ts` emits signal-only (no ElevenLabs request, `audioBase64` absent) for a kokoro-qualified project voice and pre-renders unchanged for bare ids. [owner:tdd-integration] [type:testing]
- [x] [4.2] Unit tests (agent): `GET /integrations/kokoro/voices` proxies the descriptor result; `GET /integrations/telegram/voices` → 404; kokoro voices with no stored row → 400. [owner:tdd-integration] [type:testing]
- [x] [4.3] Unit tests (`apps/swift/NexusSharedTests`): with stubbed providers, a `kokoro:`-qualified override drives the Kokoro attempt with the parsed voice; a bare override drives the ElevenLabs attempt exactly as before; unknown prefix falls back to no-override behavior. [owner:tdd-integration] [type:testing]
