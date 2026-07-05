# Implementation Tasks

<!-- beads:epic:nx-z7kl -->
<!-- beads:feature:nx-ocyz -->

## DB Batch

- [x] [1.1] [P-1] Add `elevenlabs_credentials` schema in `packages/db/src/schema/elevenlabsCredentials.ts` (id, agentId FK, valueEncrypted, encryptionKeyId, voiceId, voiceName, lastTestOkAt, lastTestStatusCode, createdAt, updatedAt) [owner:db-engineer] [type:db] [beads:nx-ssdg]
- [x] [1.2] [P-1] Wire the new schema into `packages/db/src/schema/index.ts` and add relations to `agents` [owner:db-engineer] [type:db] [beads:nx-bara]
- [x] [1.3] [P-2] Generate Drizzle migration via `pnpm db:generate` and verify SQL [owner:db-engineer] [type:db] [beads:nx-g3pd]
- [x] [1.4] [P-2] Encryption round-trip unit test against the new schema [owner:test-writer] [type:testing] [beads:nx-21xn]
## API Batch

- [ ] [2.1] [P-1] Add `apps/agent/src/routes/elevenlabs-credentials.ts` with `handleGetCredentials`, `handlePatchCredentials`, `handleDeleteCredentials` [owner:api-engineer] [type:api] [beads:nx-8wnn]
- [ ] [2.2] [P-1] Add `handleTestConnection` in same file proxying `GET /v1/user` [owner:api-engineer] [type:api] [beads:nx-e6snv]
- [ ] [2.3] [P-1] Add `apps/agent/src/routes/elevenlabs-voices.ts` with `handleListVoices` (1h TTL in-memory cache, per-agent) [owner:api-engineer] [type:api] [beads:nx-t6y5u]
- [ ] [2.4] [P-1] Add Zod schemas for PATCH input + all GET response shapes in `packages/core/src/schemas/elevenlabs.ts` [owner:types-engineer] [type:api] [beads:nx-j0422]
- [ ] [2.5] [P-2] Add `apps/agent/src/routes/elevenlabs-builder.ts` route table and wire into `server-request-handler.ts` after the credential routes [owner:api-engineer] [type:api] [beads:nx-80dk6]
- [ ] [2.6] [P-2] Update `apps/agent/src/notifications/channels/tts.ts` to read the DB row first, fall back to env var when row is absent [owner:api-engineer] [type:api] [beads:nx-hav1j]
- [ ] [2.7] [P-2] Bun unit tests for all 5 endpoints (auth gate, mask invariant, cache hit/miss, env fallback, signal-only when both empty) [owner:test-writer] [type:testing] [beads:nx-meuog]
## UI Batch

- [ ] [3.1] [P-1] `apps/nextjs/src/app/actions/elevenlabs-credentials.ts` server actions: `fetchCredentials`, `saveCredentials`, `testCredentials`, `deleteCredentials`, `listVoices` [owner:ui-engineer] [type:ui] [beads:nx-bnsfx]
- [ ] [3.2] [P-1] `MaskedKeyInput.tsx` component (always renders bullets when `hasKey`, accepts paste, emits onChange only when user types) [owner:ui-engineer] [type:ui] [beads:nx-j91ir]
- [ ] [3.3] [P-1] `VoiceDropdown.tsx` component fed by `listVoices` action with text-input fallback when proxy returns 5xx [owner:ui-engineer] [type:ui] [beads:nx-b4uun]
- [ ] [3.4] [P-1] `TestConnectionPanel.tsx` rendering status code + quota summary (`${characterCount} / ${characterLimit} chars` when subscription is present) [owner:ui-engineer] [type:ui] [beads:nx-wwqnx]
- [ ] [3.5] [P-2] `apps/nextjs/src/app/integrations/elevenlabs/page.tsx` composing the three components plus Save / Delete actions [owner:ui-engineer] [type:ui] [beads:nx-3aruz]
- [ ] [3.6] [P-2] Add "Integrations" group to dashboard primary nav with `/integrations/elevenlabs` link [owner:ui-engineer] [type:ui] [beads:nx-nbn9q]
## E2E Batch

- [ ] [4.1] Playwright e2e: open `/integrations/elevenlabs`, paste a test key, choose a voice, click Save, click Test, assert status code render [owner:e2e-engineer] [type:testing] [beads:nx-tov87]