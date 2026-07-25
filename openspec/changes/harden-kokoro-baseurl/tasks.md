---
stack: t3
---
<!-- beads:epic:nx-3wl4e -->
<!-- beads:feature:nx-6dyqg -->

# Tasks — harden-kokoro-baseurl

> Written against commit `9e4963b9`. Verify cited lines before each task; STOP on drift.

## API Batch

- [x] 1.1 In `packages/core/src/types/integrations.ts`, add an exported `isForbiddenTtsEndpointHost(hostname: string): boolean` helper (loopback: `localhost`, `127.*`, `::1`; link-local: `169.254.*`, `fe80:*` — lowercase + strip brackets before matching). Replace `baseUrl: z.string().url()` (line 75) with a validator enforcing scheme `http|https` AND `!isForbiddenTtsEndpointHost(new URL(v).hostname)`. Record the DNS-rebinding accepted-limitation comment from the proposal's Decision §3. [type:api] [beads:nx-9eq4f]
  - touches: `packages/core/src/types/integrations.ts`
- [x] 1.2 Co-located unit tests for the schema + helper covering the seven cases in the proposal's Testing section. Exemplar test style: `packages/core/src/config.test.ts`. [type:testing] [beads:nx-cx6z6]
  - touches: `packages/core/src/types/integrations.test.ts`
- [x] 1.3 In `apps/agent/src/integrations/registry.ts`, guard both kokoro `testProbe` (line 104) and `listVoices` (line 118): before fetching, parse `baseUrl` and return `{ ok: false, statusCode: null }` / `{ ok: false, statusCode: null, voices: [] }` if scheme or host fails the same helper (import from `@nexus/core`). Covers rows persisted before the schema change. [type:api] [beads:nx-j9184]
  - touches: `apps/agent/src/integrations/registry.ts`
- [x] 1.4 Test: forbidden persisted `baseUrl` → no fetch (stub `globalThis.fetch`, assert 0 calls). Follow `apps/agent/src/notifications/channels/tts.test.ts` mock pattern (spread-the-real-barrel, nx-jlx1c). [type:testing] [beads:nx-kowj4]
  - touches: `apps/agent/src/integrations/registry.test.ts`
- [x] 1.5 Update the "add a provider" comment block near `registry.ts:10` with the maintenance note (endpoint-URL providers must reuse the guard). [type:api] [beads:nx-kis2w]

## E2E Batch

- [ ] 2.1 Verify: `bun test packages/core apps/agent/src/integrations`, `pnpm typecheck`, `pnpm lint` green; paste output. [type:testing] [beads:nx-0qysa]

## Out of scope (do not touch)
- No auth gates on routes (`server-auth.ts` — settled by `drop-attach-secret-gate`).
- No changes to telegram provider, Swift apps, or `fetchWithTimeout` itself.
