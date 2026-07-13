# integration-registry Specification

## Purpose
TBD - created by archiving change add-integration-registry. Update Purpose after archive.
## Requirements
### Requirement: A provider-keyed table SHALL persist one encrypted-secret row per (agent, provider)
A new `integration_credentials` table MUST store `provider` (text, the registry key),
`agent_id` (FK to `agents.id`, `ON DELETE CASCADE`), `value_encrypted` (AES-256-GCM ciphertext
via the existing `encrypt`/`decrypt` helpers and the existing `NEXUS_ENCRYPTION_KEY` resolution),
a `metadata` JSONB column for provider-specific non-secret fields, plus `encryption_key_id`
(default `"v1"`), `last_test_ok_at`, `last_test_status_code`, `created_at`, `updated_at`. A
unique index on `(agent_id, provider)` MUST enforce at most one row per agent/provider pair. The
existing `credentials` (Anthropic OAuth pool) and `elevenlabs_credentials` tables are NOT
migrated onto this table.

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
provider id. Each descriptor MUST supply a `metadataSchema` (Zod, validates the JSONB metadata
before persist) and a `testProbe(secret, metadata)` async function returning
`{ ok: boolean, statusCode: number | null }`. Registering a new provider MUST require exactly one
descriptor entry — no new route file, no new DB table. The initial registry MUST contain a
`telegram` descriptor: `metadataSchema` requires a non-empty `chatId` string; `testProbe` calls
`GET https://api.telegram.org/bot<secret>/getMe`.

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
- `POST /integrations/:provider/credentials/test` — runs the descriptor's `testProbe`, persists `last_test_status_code` / `last_test_ok_at` (2xx only), returns `{ ok, statusCode }`.

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
`process.env.TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. When neither is present, the existing
fail-open no-op behavior (`{ success: true }`, info log, no request) MUST be unchanged. The
channel MUST NOT cache the decrypted secret across dispatches.

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
Bot API request

#### Scenario: Rotation propagates without restart
Given the agent is running and a Telegram credential row is saved via the dashboard at time T
When the next notification is dispatched after T
Then it uses the newly saved secret without an agent restart

### Requirement: The dashboard SHALL render a generic per-provider integrations page
`apps/web/src/app/integrations/[provider]/page.tsx` MUST resolve the `provider` route param
against a client-side `PROVIDER_UI_REGISTRY` map (provider id → display name + panel component)
and render `notFound()` for an unregistered provider. The initial registry MUST contain a
`telegram` entry rendering a `TelegramPanel` — bot token via the existing `MaskedKeyInput`
component, a plain `chatId` text field, and save / test-connection / delete actions against the
`/integrations/telegram/*` endpoints.

#### Scenario: Registered provider renders its panel
Given `PROVIDER_UI_REGISTRY` contains a `telegram` entry
When a user navigates to `/integrations/telegram`
Then the Telegram panel renders with masked-key input, chat id field, and test/save/delete controls

#### Scenario: Unregistered provider 404s
Given `PROVIDER_UI_REGISTRY` has no entry for `provider="nope"`
When a user navigates to `/integrations/nope`
Then Next.js renders the standard not-found page

