---
order: 0720a
---

# Proposal: Add Kokoro as a First-Class Integration Provider

## Change ID
`add-kokoro-integration-provider`

## Why

Nexus TTS is hard-wired to ElevenLabs — a paid, network-dependent API with its own bespoke
credential stack. Local TTS research (docs/local-tts-research.md, 2026-07-20) selected
Kokoro-82M served via Kokoro-FastAPI (Apache 2.0, CPU-only, OpenAI-compatible `/v1/audio/speech`,
MP3 out) as the replacement engine. The generic integration registry
(`add-integration-registry`, archived 2026-07-13) exists precisely so a new provider lands as
one descriptor + one UI panel instead of a hand-rolled table/route/page triple — Kokoro should
be its second registrant, not a third bespoke stack. This proposal covers the agent-side
provider registration and the homelab deployment; audible playback (Swift synthesis chain) and
per-project voice mapping follow in `swift-tts-provider-chain` and
`provider-qualified-project-voices`.

## What Changes

- Register `kokoro` in `INTEGRATION_PROVIDERS` (`@nexus/core`) with metadata schema
  `{ baseUrl: url, defaultVoice?: string }`. No secret — the server is reached over Tailscale
  and Kokoro-FastAPI ships unauthenticated (repo convention: Tailscale ACLs, no token
  management).
- Extend `ProviderDescriptor` with optional `requiresSecret?: boolean` (default `true`) and
  add the `kokoro` descriptor: `testProbe` calls `GET {baseUrl}/v1/audio/voices` with a 5s
  timeout, ignoring the secret argument.
- Teach `handleTestConnection` to honor secretless providers: when
  `requiresSecret === false`, a row with metadata but no `value_encrypted` is testable
  (probe invoked with `""`); the existing 400 `"no credential stored"` path is unchanged for
  secret-requiring providers.
- Add `KokoroPanel` to the generic `/integrations/[provider]` dashboard page
  (`PROVIDER_UI_REGISTRY`): baseUrl + defaultVoice fields, Test Connection, no secret input.
- Commit `deploy/kokoro/docker-compose.yml` (`ghcr.io/remsky/kokoro-fastapi-cpu`, port 8880)
  plus a deploy/README.md section documenting homelab placement and Tailscale-only exposure.

## Context

- depends on: (none — first proposal in the Kokoro sequence)
- touches: `packages/core/src/types/integrations.ts`, `apps/agent/src/integrations/registry.ts`, `apps/agent/src/routes/integration-credentials.ts`, `apps/agent/src/routes/integration-credentials.test.ts`, `apps/web/src/app/integrations/[provider]/page.tsx`, `apps/web/src/app/integrations/[provider]/KokoroPanel.tsx`, `deploy/kokoro/docker-compose.yml`, `deploy/README.md`

- Extends: `apps/agent/src/integrations/registry.ts` (`PROVIDER_DESCRIPTORS` — second
  registrant after telegram; gains the `requiresSecret` field)
- Extends: `apps/agent/src/routes/integration-credentials.ts` (secretless test path only;
  CRUD handlers unchanged)
- Related: archive `2026-07-13-add-integration-registry` (the pattern this proposal is the
  first real consumer of), capability `elevenlabs-credential` (explicitly NOT modified —
  ElevenLabs stays on its bespoke stack until/unless a later consolidation proposal
  supersedes it)
- Related: docs/local-tts-research.md (engine selection rationale)

## Impact

- Affected specs: `integration-registry` (MODIFIED: descriptor shape gains `requiresSecret`,
  registry gains the kokoro entry, test endpoint honors secretless providers),
  `kokoro-provider` (ADDED: new capability — deployable server + dashboard panel)
- Affected code: `@nexus/core` types, agent registry + one route handler, one new web panel,
  new deploy artifact. No DB schema change — `integration_credentials` is already generic.
- ElevenLabs paths (`elevenlabs-credentials.ts`, `elevenlabs-voices.ts`, Swift
  `ElevenLabsClient`) untouched.

## Done Means

- Operator can `docker compose up -d` from `deploy/kokoro/` on the homelab and reach
  `http://<tailscale-ip>:8880/v1/audio/voices` from any tailnet machine.
- `/integrations/kokoro` renders a panel with baseUrl + defaultVoice fields and a working
  Test Connection button; saving persists a row via the existing generic PATCH route.
- Test Connection succeeds against a stored baseUrl with no secret ever entered.
- `/integrations/telegram` behavior is unchanged (still requires its secret to test).

## Testing

- Unit (`integration-credentials.test.ts`): secretless test-connection path — row with
  metadata but no secret probes successfully for `kokoro`; telegram still 400s without a
  secret; invalid `baseUrl` metadata rejected with 400 and no write (tasks 4.1).
- Playwright: `/integrations/kokoro` save → test → delete round trip; unregistered provider
  still 404s (task 4.2).
- Deploy: N/A — compose file is declarative config; verified by the Done Means curl against
  a running container, not CI.
