---
status: draft
---

# Proposal: Provider-Keyed Integration Credential Registry

## Change ID
`add-integration-registry`

## Summary
Introduce a provider-keyed `integration_credentials` table plus a small server-side provider
descriptor registry, so adding a new API-key-based integration no longer requires hand-rolling a
dedicated table, route file, and Zod schema pair. Prove the pattern out by migrating Telegram's
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` off `process.env` onto it, giving Telegram the same
dashboard-managed, encrypted, rotate-without-restart treatment ElevenLabs already got. The
existing `credentials` (Anthropic OAuth pool) and `elevenlabs_credentials` tables are explicitly
untouched — this generalizes the pattern for future providers, it does not migrate the two most
specialized existing tables onto it.

## Context
- Extends: `apps/agent/src/credentials/encryption.ts` (AES-256-GCM `encrypt`/`decrypt`/
  `tryLoadEncryptionKey` helpers reused as-is, no changes)
- Extends: `apps/agent/src/notifications/router.ts` (`sendTelegramNotification` — DB row takes
  precedence over env vars; existing fail-open discipline is preserved unchanged)
- Extends: `apps/agent/src/server-request-handler.ts` (new route group registration, same pattern
  as the existing `tryHandleElevenlabsRoute` delegation)
- Related: archive `2026-07-05-add-elevenlabs-credential` — source of the DB-over-env,
  rotate-without-restart, masked-response, fail-open-on-missing-key precedent this proposal
  generalizes into a reusable shape
- Related: capability `elevenlabs-credential` (encryption-at-rest precedent; NOT modified here),
  capability `credential-pool` (Anthropic OAuth pool; NOT modified here)
- touches: `packages/db/src/schema/integrationCredentials.ts`, `packages/db/src/schema/index.ts`, `packages/core/src/types/integrations.ts`, `packages/core/src/index.ts`, `apps/agent/src/integrations/registry.ts`, `apps/agent/src/routes/integration-credentials.ts`, `apps/agent/src/server-request-handler.ts`, `apps/agent/src/notifications/router.ts`, `apps/web/src/app/integrations/[provider]/page.tsx`, `apps/web/src/app/integrations/[provider]/TelegramPanel.tsx`, `apps/web/src/lib/integration-client.ts`, `.env.example`, `deploy/secrets.env.example`

## Motivation
Telegram's bot token and chat id are still `process.env`-only
(`apps/agent/src/notifications/router.ts:315`) — exactly the pain ElevenLabs had before
`add-elevenlabs-credential` gave it a dashboard-managed, encrypted, rotate-without-restart row
instead of an SSH-and-restart cycle. Hand-rolling that same ~250-line pattern (dedicated table,
route file, Zod schema pair, dashboard page) a second time for Telegram — and a third time for
whatever integration follows — duplicates a shape that's identical across providers except for
which field is the secret and which upstream URL verifies it. A provider-keyed table plus a small
descriptor registry collapses "add provider N" to "register one descriptor + author one small UI
panel," while deliberately leaving the two already-complex, actively-used tables (`credentials`'s
OAuth lease/cooldown/dedup pool, `elevenlabs_credentials`'s per-agent voice config) exactly as they
are today — this is architecture generalization for what comes next, not a migration of what
already works.

## Requirements

### Requirement: A provider-keyed table SHALL persist one encrypted-secret row per (agent, provider)
A new `integration_credentials` table MUST store `provider` (text, the registry key),
`agent_id` (FK to `agents.id`, `ON DELETE CASCADE` — mirrors `elevenlabs_credentials`'s per-agent
ownership), `value_encrypted` (AES-256-GCM ciphertext via the existing `encrypt`/`decrypt`
helpers and the existing `NEXUS_ENCRYPTION_KEY` resolution — no new key material), a `metadata`
JSONB column for provider-specific non-secret fields (e.g. Telegram's `chatId`), plus
`encryption_key_id` (default `"v1"`), `last_test_ok_at`, `last_test_status_code`, `created_at`,
`updated_at`. A unique index on `(agent_id, provider)` MUST enforce at most one row per
agent/provider pair.

#### Scenario: Encrypted insert
Given the master encryption key is configured
When the dashboard saves a Telegram bot token for agent "homelab"
Then a row appears in `integration_credentials` with `provider="telegram"`,
`agent_id="homelab"`, `value_encrypted` is non-empty base64, and `decrypt(value_encrypted)`
equals the input token

#### Scenario: Cascade on agent deletion
Given an agent row and a matching `integration_credentials` row both exist
When the agent row is deleted
Then the `integration_credentials` row is also deleted

#### Scenario: Second provider for the same agent does not collide
Given agent "homelab" already has an `integration_credentials` row for `provider="telegram"`
When a row is inserted for the same agent with `provider="some-other-provider"`
Then both rows persist independently (the unique index is on the pair, not `agent_id` alone)

### Requirement: A server-side provider descriptor registry SHALL define the fields, metadata schema, and test probe per provider
`apps/agent/src/integrations/registry.ts` MUST export a `PROVIDER_DESCRIPTORS` map keyed by
provider id. Each descriptor MUST supply: a `metadataSchema` (Zod, validates the JSONB metadata
before persist), and a `testProbe(secret, metadata)` async function that calls the provider's
verification endpoint and returns `{ ok: boolean, statusCode: number | null }`. Registering a new
provider MUST require adding exactly one descriptor entry — no new route file, no new DB table.
The initial registry MUST contain a `telegram` descriptor: `metadataSchema` requires a non-empty
`chatId` string; `testProbe` calls `GET https://api.telegram.org/bot<secret>/getMe`.

#### Scenario: Unknown provider is rejected before touching the DB
Given a request names `provider="not-a-real-provider"`
When any `/integrations/:provider/credentials` route handles it
Then the response is HTTP 404 with body `{"error":"unknown provider"}` and no DB query runs

#### Scenario: Metadata fails descriptor validation
Given the Telegram descriptor requires a non-empty `chatId`
When PATCH `/integrations/telegram/credentials` is called with `metadata: { chatId: "" }`
Then the agent returns HTTP 400 with a validation error and the row is NOT written

### Requirement: HTTP endpoints MUST expose generic CRUD + test operations parameterized by provider
The agent MUST expose, generically dispatched off the registry:
- `GET /integrations/:provider/credentials` — returns `{ provider, hasSecret: boolean, metadata, lastTestOkAt, lastTestStatusCode, agentId }`. MUST NEVER return the raw secret or `value_encrypted`.
- `PATCH /integrations/:provider/credentials` — accepts `{ secret?: string, metadata?: object }`. Validates `metadata` against the descriptor's `metadataSchema` before persisting. Encrypts `secret` when supplied. Returns the masked GET shape.
- `DELETE /integrations/:provider/credentials` — removes the row.
- `POST /integrations/:provider/credentials/test` — runs the descriptor's `testProbe` against the stored secret + metadata, persists `last_test_status_code` / `last_test_ok_at` (2xx only), and returns `{ ok, statusCode }`.

Mirrors the existing `/elevenlabs/credentials` endpoint contract (same masking, same 400-on-missing-key behavior) but generic across any registered provider instead of one hand-rolled route file per provider.

#### Scenario: Encryption key missing
Given `NEXUS_ENCRYPTION_KEY` is not set in the agent process
When PATCH `/integrations/telegram/credentials` is called with a new secret
Then the agent returns HTTP 400 with body `{"error":"encryption key not configured"}` and the row is NOT written

#### Scenario: Masked response never leaks the secret
Given a Telegram credential row exists with a stored secret
When GET `/integrations/telegram/credentials` is called
Then the response body contains `hasSecret: true` and no field derived from `value_encrypted` or the decrypted secret

### Requirement: The Telegram notification channel MUST prefer the DB row over env vars, preserving existing fail-open behavior
On every Telegram dispatch, `sendTelegramNotification` MUST query `integration_credentials` for
`provider="telegram"` matching the running agent's id before falling back to
`process.env.TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. When neither the DB row nor the env vars
are present, the existing fail-open no-op behavior (accept the request, `{ success: true }`,
info log) MUST be unchanged. The channel MUST NOT cache the decrypted secret across dispatches —
it re-reads on each call, matching the rotate-without-restart guarantee ElevenLabs already has.

#### Scenario: DB row wins over env
Given an `integration_credentials` row exists for `provider="telegram"` with secret `AAA` and
metadata `chatId="111"`
And `TELEGRAM_BOT_TOKEN=BBB` / `TELEGRAM_CHAT_ID=222` are set in the env
When a notification is dispatched
Then the Bot API request uses token `AAA` and chat id `111` (env is ignored)

#### Scenario: Env fallback when no row
Given no `integration_credentials` row exists for `provider="telegram"`
And `TELEGRAM_BOT_TOKEN=CCC` / `TELEGRAM_CHAT_ID=333` are set in the env
When a notification is dispatched
Then the Bot API request uses token `CCC` and chat id `333`

#### Scenario: Fail-open unchanged when neither is present
Given no `integration_credentials` row exists and no env vars are set
When a notification is dispatched
Then `sendTelegramNotification` returns `{ success: true }`, logs at info level, and makes no
Bot API request — identical to today's env-only-unset behavior

#### Scenario: Rotation propagates without restart
Given the agent is running and a Telegram credential row is saved via the dashboard at time T
When the next notification is dispatched after T
Then it uses the newly saved secret without an agent restart

### Requirement: The dashboard SHALL render a generic per-provider integrations page
`apps/web/src/app/integrations/[provider]/page.tsx` MUST resolve the `provider` route param
against a small client-side `PROVIDER_UI_REGISTRY` map (provider id → display name + panel
component) and render `notFound()` for an unregistered provider. The initial registry MUST
contain a `telegram` entry rendering a `TelegramPanel` — bot token via the existing
`MaskedKeyInput` component, a plain `chatId` text field, save, test-connection, and delete
actions against the `/integrations/telegram/*` endpoints — following the same page shell
conventions as the existing (unmodified) `/integrations/elevenlabs` page.

#### Scenario: Registered provider renders its panel
Given `PROVIDER_UI_REGISTRY` contains a `telegram` entry
When a user navigates to `/integrations/telegram`
Then the Telegram panel renders with masked-key input, chat id field, and test/save/delete controls

#### Scenario: Unregistered provider 404s
Given `PROVIDER_UI_REGISTRY` has no entry for `provider="nope"`
When a user navigates to `/integrations/nope`
Then Next.js renders the standard not-found page

## Scope
- **IN**: new `integration_credentials` table; `apps/agent/src/integrations/registry.ts`
  provider-descriptor pattern; generic `/integrations/:provider/*` agent routes; Telegram
  descriptor + migration of `sendTelegramNotification` off pure-env-var config; generic
  `/integrations/[provider]` dashboard route with a `TelegramPanel`.
- **OUT**: migrating `credentials` (Anthropic OAuth pool — lease/cooldown/dedup/usage logic is
  too specialized to generalize safely) or `elevenlabs_credentials` (already shipped, working,
  per-agent voice config) onto the new table. Both keep their existing tables, routes, and pages
  unchanged.
- **OUT**: a top-level `/integrations` index/listing page — the existing `/integrations/elevenlabs`
  route has no index today either; this proposal keeps that convention rather than introducing a
  new UI surface with only one real registered provider to list.
- **OUT**: any change to the ElevenLabs table, routes, or page.

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `integration_credentials` schema + encrypted round trip | [4.1] | N/A — no user-facing flow beyond the route layer |
| `apps/agent/src/routes/integration-credentials.ts` (GET/PATCH/DELETE/POST-test, masking, unknown-provider 404, metadata validation) | [4.1] | [4.3] |
| `apps/agent/src/notifications/router.ts` `sendTelegramNotification` (DB-wins, env-fallback, fail-open, no-cache rotation) | [4.2] | N/A — covered by unit-level Bot API mock; no Playwright surface |
| `apps/web/src/app/integrations/[provider]/page.tsx` + `TelegramPanel` (registered-provider render, unregistered-provider 404, save/test/delete) | N/A — component logic covered by E2E | [4.3] |

## Impact
| Area | Change |
|------|--------|
| `packages/db` | New table `integration_credentials` + one migration; no changes to `credentials` or `elevenlabs_credentials` |
| `packages/core` | New `packages/core/src/types/integrations.ts` (wire Zod schemas, shared agent+dashboard) |
| `apps/agent` | New `integrations/registry.ts`, new `routes/integration-credentials.ts`, `notifications/router.ts` Telegram channel gains DB-first lookup, `server-request-handler.ts` gains one route delegation |
| `apps/web` | New `app/integrations/[provider]/page.tsx` + `TelegramPanel.tsx`, new `lib/integration-client.ts` |
| Deploy | `.env.example` / `deploy/secrets.env.example` gain a note that `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are now a DB-managed fallback path, not the primary config surface |

## Risks
| Risk | Mitigation |
|------|-----------|
| JSONB `metadata` is unvalidated at the DB layer | Validated at the API layer via the descriptor's `metadataSchema` (Zod) before every write; same discipline `elevenlabs_credentials` already applies to its plain columns via `elevenlabsPatchInput` |
| A future provider's `testProbe` could be a slow/hanging upstream call, blocking the request | Reuse the existing `fetchWithTimeout` helper (already used by both ElevenLabs and Telegram callers) with the same timeout convention (5-8s) |
| Telegram chat id is stored as plain metadata alongside an encrypted secret in the same row | Mirrors the already-established `elevenlabs_credentials.voice_id`/`voice_name` precedent (plain metadata beside an encrypted secret is not a new exposure class) |
| Two credential systems for the same conceptual thing (`elevenlabs_credentials` hand-rolled, `integration_credentials` generic) could confuse future authors about which to extend | Proposal `## Scope` and this table's schema doc comment explicitly state ElevenLabs is intentionally NOT migrated and why; a future proposal can revisit that call once the registry has proven itself with 2+ real providers |
