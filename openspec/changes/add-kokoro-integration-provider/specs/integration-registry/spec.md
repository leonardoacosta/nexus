# integration-registry — Delta

## MODIFIED Requirements

### Requirement: A server-side provider descriptor registry SHALL define the fields, metadata schema, and test probe per provider
`apps/agent/src/integrations/registry.ts` MUST export a `PROVIDER_DESCRIPTORS` map keyed by
provider id. Each descriptor MUST supply a `metadataSchema` (Zod, validates the JSONB metadata
before persist) and a `testProbe(secret, metadata)` async function returning
`{ ok: boolean, statusCode: number | null }`. A descriptor MAY set `requiresSecret: false` to
declare a secretless provider (absent means `true`). Registering a new provider MUST require
exactly one descriptor entry — no new route file, no new DB table. The registry MUST contain a
`telegram` descriptor (`metadataSchema` requires a non-empty `chatId` string; `testProbe` calls
`GET https://api.telegram.org/bot<secret>/getMe`) and a `kokoro` descriptor
(`requiresSecret: false`; `metadataSchema` requires a URL `baseUrl` and accepts an optional
non-empty `defaultVoice`; `testProbe` calls `GET {baseUrl}/v1/audio/voices` ignoring the secret
argument).

#### Scenario: Unknown provider is rejected before touching the DB
Given a request names `provider="not-a-real-provider"`
When any `/integrations/:provider/credentials` route handles it
Then the response is HTTP 404 with body `{"error":"unknown provider"}` and no DB query runs

#### Scenario: Metadata fails descriptor validation
Given the Telegram descriptor requires a non-empty `chatId`
When PATCH `/integrations/telegram/credentials` is called with `metadata: { chatId: "" }`
Then the agent returns HTTP 400 with a validation error and the row is NOT written

#### Scenario: Kokoro metadata requires a valid baseUrl
Given the Kokoro descriptor requires `baseUrl` to be a URL
When PATCH `/integrations/kokoro/credentials` is called with `metadata: { baseUrl: "not-a-url" }`
Then the agent returns HTTP 400 with a validation error and the row is NOT written

### Requirement: HTTP endpoints MUST expose generic CRUD + test operations parameterized by provider
The agent MUST expose, generically dispatched off the registry:
- `GET /integrations/:provider/credentials` — returns `{ provider, hasSecret: boolean, metadata, lastTestOkAt, lastTestStatusCode, agentId }`. MUST NEVER return the raw secret or `value_encrypted`.
- `PATCH /integrations/:provider/credentials` — accepts `{ secret?: string, metadata?: object }`. Validates `metadata` against the descriptor's `metadataSchema` before persisting. Encrypts `secret` when supplied. Returns the masked GET shape.
- `DELETE /integrations/:provider/credentials` — removes the row.
- `POST /integrations/:provider/credentials/test` — runs the descriptor's `testProbe`, persists `last_test_status_code` / `last_test_ok_at` (2xx only), returns `{ ok, statusCode }`. For a descriptor with `requiresSecret: false`, a row with metadata but no stored secret MUST be testable — the probe is invoked with an empty-string secret and the stored metadata. For secret-requiring descriptors, a row without a stored secret MUST return HTTP 400 `{"error":"no credential stored"}` unchanged.

#### Scenario: Encryption key missing
Given `NEXUS_ENCRYPTION_KEY` is not set in the agent process
When PATCH `/integrations/telegram/credentials` is called with a new secret
Then the agent returns HTTP 400 with body `{"error":"encryption key not configured"}` and the row is NOT written

#### Scenario: Masked response never leaks the secret
Given a Telegram credential row exists with a stored secret
When GET `/integrations/telegram/credentials` is called
Then the response body contains `hasSecret: true` and no field derived from `value_encrypted` or the decrypted secret

#### Scenario: Secretless provider is testable without a stored secret
Given a `kokoro` row exists with `metadata.baseUrl` set and no `value_encrypted`
When POST `/integrations/kokoro/credentials/test` is called
Then the descriptor's `testProbe` runs with an empty-string secret and the stored metadata, and `last_test_status_code` is persisted

#### Scenario: Secret-requiring provider still rejects a secretless test
Given a `telegram` row exists with metadata but no stored secret
When POST `/integrations/telegram/credentials/test` is called
Then the agent returns HTTP 400 with body `{"error":"no credential stored"}` and no probe runs
