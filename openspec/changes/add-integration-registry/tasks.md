<!-- beads:epic:nx-3wl4e -->
<!-- beads:feature:nx-a19ps -->

# Implementation Tasks

## DB Batch

- [x] [1.1] [P-2] Add `packages/db/src/schema/integrationCredentials.ts` — `integration_credentials` table (`provider`, `agent_id` FK cascade, `value_encrypted`, `encryption_key_id`, `metadata` jsonb, `last_test_ok_at`, `last_test_status_code`, timestamps) with a unique index on `(agent_id, provider)`; export table + relations + `IntegrationCredential`/`NewIntegrationCredential` types from `packages/db/src/schema/index.ts`. [owner:db-engineer] [type:db] [beads:nx-juxwl]
- [x] [1.2] [P-2] Run `drizzle-kit generate` and commit the resulting migration `.sql` — never `db:push`. [owner:db-engineer] [type:db] [beads:nx-l0mt0]

## API Batch

- [x] [2.1] [P-2] Add `packages/core/src/types/integrations.ts` — `INTEGRATION_PROVIDERS` const array (seeded with `"telegram"`), `integrationMetadataSchemas` map (Zod, `telegram: { chatId: z.string().min(1) }`), `integrationCredentialsResponse` and `integrationPatchInput` Zod schemas (mirror `packages/core/src/types/elevenlabs.ts` conventions: `hasSecret` boolean, never expose the raw secret). Export from `packages/core/src/index.ts`. [owner:types-engineer] [type:api] [beads:nx-e0ipl]
- [ ] [2.2] [P-2] Add `apps/agent/src/integrations/registry.ts` — `ProviderDescriptor` interface (`provider`, `metadataSchema`, `testProbe`) and `PROVIDER_DESCRIPTORS` map with a `telegram` entry (`testProbe` calls `GET https://api.telegram.org/bot<secret>/getMe` via `fetchWithTimeout`, 5s timeout). See design.md § ProviderDescriptor shape. [owner:api-engineer] [type:api] [beads:nx-8c0uo]
- [ ] [2.3] [P-2] Add `apps/agent/src/routes/integration-credentials.ts` — generic `GET`/`PATCH`/`DELETE /integrations/:provider/credentials` and `POST /integrations/:provider/credentials/test` handlers, dispatched off `PROVIDER_DESCRIPTORS`. Unknown provider → 404 `{"error":"unknown provider"}` before any DB query. Mirror `apps/agent/src/routes/elevenlabs-credentials.ts`'s masking/400-on-missing-key/network-error-handling conventions. [owner:api-engineer] [type:api] [beads:nx-8db9x]
- [ ] [2.4] [P-2] Register the new routes in `apps/agent/src/server-request-handler.ts` (same delegation pattern as `tryHandleElevenlabsRoute`). [owner:api-engineer] [type:api] [beads:nx-atutd]
- [ ] [2.5] [P-2] Update `sendTelegramNotification` in `apps/agent/src/notifications/router.ts` to query `integration_credentials` (`provider="telegram"`, current agent id) before falling back to `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` env vars; preserve the existing fail-open behavior (no-op + info log) when neither is present; do not cache the decrypted secret across dispatches. [owner:api-engineer] [type:api] [beads:nx-czfal]
- [ ] [2.6] [P-3] Update `.env.example` and `deploy/secrets.env.example` Telegram section to note the vars are now a fallback beneath the DB-managed `/integrations/telegram` credential, not the primary config surface. [owner:api-engineer] [type:docs] [beads:nx-rz9v9]

## UI Batch

- [ ] [3.1] [P-2] Add `apps/web/src/lib/integration-client.ts` — generic fetch helpers (`getCredentials`, `patchCredentials`, `deleteCredentials`, `testConnection`) parameterized by `provider`, mirroring `apps/web/src/lib/elevenlabs-client.ts`'s shape. [owner:ui-engineer] [type:ui] [beads:nx-taczp]
- [ ] [3.2] [P-2] Add `apps/web/src/app/integrations/[provider]/page.tsx` — resolves `provider` against a `PROVIDER_UI_REGISTRY` map (display name + panel component), calls `notFound()` for an unregistered provider, otherwise mounts the registered panel using the same agent-URL-gate shell as the existing `/integrations/elevenlabs/page.tsx`. [owner:ui-engineer] [type:ui] [beads:nx-gwnmw]
- [ ] [3.3] [P-2] Add `apps/web/src/app/integrations/[provider]/TelegramPanel.tsx` — reuses the existing `MaskedKeyInput` component for the bot token, a plain text field for `chatId`, and save/test-connection/delete actions against `integration-client.ts`. Register it in `PROVIDER_UI_REGISTRY` under `"telegram"`. [owner:ui-engineer] [type:ui] [beads:nx-w6jlh]

## E2E Batch

- [ ] [4.1] Unit tests for `apps/agent/src/routes/integration-credentials.ts` — encrypted round trip, masked GET response never exposes the secret, unknown-provider 404 before DB query, metadata validation failure (empty `chatId`) returns 400 without writing, missing encryption key returns 400. [owner:tdd-integration] [type:testing] [beads:nx-g8s3d]
- [ ] [4.2] Unit tests for `sendTelegramNotification` — DB row wins over env, env fallback when no row, fail-open unchanged when neither present, rotation propagates without restart (no secret caching). [owner:tdd-integration] [type:testing] [beads:nx-je3mv]
- [ ] [4.3] Playwright test for the Telegram integration panel at `/integrations/telegram` — save token + chat id, run test connection, delete, and confirm an unregistered provider route (`/integrations/nope`) 404s. [owner:e2e-engineer] [type:testing] [beads:nx-i03l4]
