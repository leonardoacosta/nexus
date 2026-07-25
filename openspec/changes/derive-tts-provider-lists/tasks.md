---
stack: t3
---
<!-- beads:epic:nx-3wl4e -->
<!-- beads:feature:nx-domn3 -->

# Tasks — derive-tts-provider-lists

## API Batch

- [x] 1.1 In `packages/core/src/types/integrations.ts`, declare the TTS-capable subset adjacent to `INTEGRATION_PROVIDERS` (e.g. `const TTS_CAPABLE_INTEGRATION_PROVIDERS = ["kokoro"] as const`) and redefine `TTS_VOICE_PROVIDERS = new Set(["elevenlabs", ...TTS_CAPABLE_INTEGRATION_PROVIDERS])`. Keep the existing doc comment's elevenlabs-legacy explanation (:27-35), updating it to describe the derivation. [type:api] [beads:nx-4wu5s]
  - touches: `packages/core/src/types/integrations.ts`
- [x] 1.2 In `apps/agent/src/integrations/registry.test.ts` (extend or create), assert every `PROVIDER_DESCRIPTORS` key is in `INTEGRATION_PROVIDERS`, and that `TTS_VOICE_PROVIDERS` == `{"elevenlabs","kokoro"}` at base (membership pin). [type:testing] [beads:nx-ji52g]
  - touches: `apps/agent/src/integrations/registry.test.ts`
- [x] 1.3 Update the add-a-provider comment block at `registry.ts:~10` to enumerate ALL membership sites, including the cross-language Swift copy in `apps/swift/NexusShared/Observers/TTSObserver.swift` (comment only). [type:api] [beads:nx-ag9o3]
  - touches: `apps/agent/src/integrations/registry.ts`

## E2E Batch

- [ ] 2.1 Verify: `pnpm typecheck` + `bun test packages/core apps/agent/src/integrations` green; paste output. [type:testing] [beads:nx-66zse]
