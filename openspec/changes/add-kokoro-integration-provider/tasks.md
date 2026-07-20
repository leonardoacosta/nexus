---
stack: t3
---

# Implementation Tasks

## DB Batch

(no tasks — `integration_credentials` is already provider-generic; no schema change)

## API Batch

- [ ] [2.1] [P-2] Append `"kokoro"` to `INTEGRATION_PROVIDERS` in `packages/core/src/types/integrations.ts` and add `integrationMetadataSchemas.kokoro = z.object({ baseUrl: z.string().url(), defaultVoice: z.string().min(1).optional() })`. No new exports needed — the maps are already exported from `packages/core/src/index.ts`. [owner:api-engineer] [type:api]
- [ ] [2.2] [P-2] In `apps/agent/src/integrations/registry.ts`, add optional `requiresSecret?: boolean` to `ProviderDescriptor` (absent = `true`) and register the `kokoro` descriptor: `requiresSecret: false`, `metadataSchema: integrationMetadataSchemas.kokoro`, `testProbe` calls `GET {metadata.baseUrl}/v1/audio/voices` via `fetchWithTimeout` (5s), ignores the secret argument, never throws (network failure → `{ ok: false, statusCode: null }`). [owner:api-engineer] [type:api]
- [ ] [2.3] [P-2] In `apps/agent/src/routes/integration-credentials.ts` `handleTestConnection`, branch on `descriptor.requiresSecret === false`: require an existing row (404-provider and 400-no-row semantics unchanged) but skip the `value_encrypted`/decrypt gate and invoke `testProbe("", row.metadata ?? {})`. Secret-requiring providers keep the exact current behavior. [owner:api-engineer] [type:api]
- [ ] [2.4] [P-3] Add `deploy/kokoro/docker-compose.yml` (`ghcr.io/remsky/kokoro-fastapi-cpu:latest`, port `8880:8880`, `restart: unless-stopped`) and a `deploy/README.md` section: homelab placement next to `homelab-postgres`, Tailscale-only exposure (no public bind), example `curl {baseUrl}/v1/audio/speech` synthesis call, and the `/integrations/kokoro` dashboard hookup. [owner:api-engineer] [type:docs]

## UI Batch

- [ ] [3.1] [P-2] Add `apps/web/src/app/integrations/[provider]/KokoroPanel.tsx` — plain text fields for `baseUrl` and `defaultVoice` (no `MaskedKeyInput`, no secret), save/test-connection/delete against the existing generic `integration-client.ts`; register it in `PROVIDER_UI_REGISTRY` under `"kokoro"` in `page.tsx`. [owner:ui-engineer] [type:ui]

## E2E Batch

- [ ] [4.1] Unit tests for the secretless test path in `apps/agent/src/routes/integration-credentials.test.ts`: kokoro row with metadata + no secret → probe runs and persists `last_test_status_code`; kokoro with no row at all → 400; telegram without secret → still 400 `"no credential stored"`; PATCH kokoro with non-URL `baseUrl` → 400, no write. [owner:tdd-integration] [type:testing]
- [ ] [4.2] Playwright test for `/integrations/kokoro`: save baseUrl + defaultVoice, run Test Connection (agent route mocked), delete; confirm no secret input renders and `/integrations/nope` still 404s. [owner:e2e-engineer] [type:testing]
