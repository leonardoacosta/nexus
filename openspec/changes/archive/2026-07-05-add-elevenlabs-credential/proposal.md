# Proposal: ElevenLabs Credential Management

## Change ID
`add-elevenlabs-credential`

## Summary
Move the ElevenLabs API key and voice ID out of `process.env` and into a per-agent encrypted DB row that the dashboard can manage at runtime. Adds a new `/integrations/elevenlabs` page with rotate-without-restart, a "Test connection" probe against `/v1/user`, and a voice dropdown sourced from `/v1/voices`. Mirrors the existing Anthropic `credentials` table's encryption-at-rest pattern.

## Context
- Extends: `apps/agent/src/notifications/channels/tts.ts` (currently reads `process.env.ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`)
- Extends: `packages/db/src/schema/credentials.ts` (encryption pattern to mirror — `valueEncrypted` + `encryptionKeyId`)
- Extends: `apps/agent/src/credentials/encryption.ts` (AES-256-GCM helpers reused as-is)
- Extends: `apps/agent/src/server-request-handler.ts` (new route group registration)
- Extends: `apps/nextjs/src/app/` (new `/integrations/elevenlabs` page; new `actions/elevenlabs-credentials.ts`)
- Related: archive `2026-04-07-encrypt-credential-storage` (encryption pattern source)
- Related: capability `credential-pool`, `credential-analytics` (per-agent credential management precedent)
- Related: in-flight `restore-tts-mac-audio-dispatch` — this change does NOT block it; both can land independently

## Motivation
Today's pain (observed 2026-04-26): the homelab agent's `ELEVENLABS_API_KEY` is rejected with HTTP 401 — the key is expired or revoked, and there's no way to rotate it without SSH-ing into homelab, editing `~/.config/nexus/secrets.env`, and restarting the systemd service. Today's session shipped a graceful-degradation fix so failed synths fall back to local `say(1)`, but the underlying configuration burden remains.

This change makes rotation a one-click dashboard action and surfaces quota state inline so the user knows when they're approaching the cap. It is also the first slice of three (`elevenlabs-credential` → `elevenlabs-usage` → `elevenlabs-dashboard`) that together replace env-var ElevenLabs config with a managed integration. Landing the credential layer first unblocks the others without forcing a single mega-spec.

## Requirements

### Requirement: Encrypted credential storage SHALL persist API key + voice metadata per agent
A new `elevenlabs_credentials` table MUST persist per-agent ElevenLabs configuration. The `value_encrypted` column MUST hold the API key as AES-256-GCM ciphertext using the existing `encrypt`/`decrypt` helpers from `apps/agent/src/credentials/encryption.ts` and the existing master-key resolution. Voice metadata (`voice_id`, `voice_name`) MUST be stored plain text. Each row MUST have a foreign key to `agents.id` with `ON DELETE CASCADE`. The table MUST also store `encryption_key_id` (default `"v1"`), `last_test_ok_at`, `last_test_status_code`, `created_at`, and `updated_at`.

#### Scenario: Encrypted insert
Given the master encryption key is configured
When the dashboard saves an API key for agent "homelab"
Then a row appears in `elevenlabs_credentials` with `agent_id="homelab"`, `value_encrypted` is non-empty base64, and `decrypt(value_encrypted)` equals the input

#### Scenario: Encryption key missing
Given `NEXUS_ENCRYPTION_KEY` is not set in the agent process
When PATCH /elevenlabs/credentials is called with a new key
Then the agent returns HTTP 400 with body `{"error":"encryption key not configured"}` and the row is NOT written

#### Scenario: Cascade on agent deletion
Given an agent row and its matching `elevenlabs_credentials` row both exist
When the agent row is deleted
Then the `elevenlabs_credentials` row is also deleted

### Requirement: The TTS channel MUST prefer the DB row over the ELEVENLABS_API_KEY env variable
On every TTS dispatch, the channel MUST query `elevenlabs_credentials` for a row matching the running agent's id. When the row exists, the decrypted `api_key` and `voice_id` take precedence over `process.env.ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID`. When the row is absent, the env vars MUST be used (backwards compatibility for homelabs that haven't migrated). When neither is present, the channel MUST stay in signal-only mode without regression.

#### Scenario: DB row wins over env
Given a row exists for the running agent with `api_key=AAA`
And `ELEVENLABS_API_KEY=BBB` is set in the env
When the channel synthesizes a notification
Then the request uses `AAA` (env is ignored)

#### Scenario: Env fallback when no row
Given no row exists for the running agent
And `ELEVENLABS_API_KEY=CCC` is set in the env
When the channel synthesizes
Then the request uses `CCC`

#### Scenario: Signal-only when neither
Given no row exists and no env var is set
When the channel runs
Then `sendTtsNotification` returns `{ success: true, audioBase64: undefined }` and no HTTP request is made

### Requirement: Rotate-without-restart MUST be supported
After the dashboard PATCHes a new `api_key` or `voice_id`, subsequent TTS dispatches MUST use the new value WITHOUT requiring an agent restart. The channel SHALL re-read the row from DB on each dispatch (no in-memory cache that could survive an update).

#### Scenario: Rotation propagates within one dispatch cycle
Given the agent is running with `api_key=A`
When the dashboard saves `api_key=B` at time T
Then the next TTS dispatch fired after T uses `api_key=B`

### Requirement: HTTP endpoints MUST expose CRUD + test + voice-list operations
The agent MUST expose under `/elevenlabs/`:
- `GET /elevenlabs/credentials` — returns `{ hasKey: boolean, voiceId: string | null, voiceName: string | null, lastTestOkAt: string | null, lastTestStatusCode: number | null, agentId: string }`. MUST NEVER return the raw key, value_encrypted, or any partial form of the key.
- `PATCH /elevenlabs/credentials` — accepts `{ apiKey?: string, voiceId?: string, voiceName?: string }`. Encrypts and persists the parts that were supplied. Returns the masked GET shape.
- `DELETE /elevenlabs/credentials` — removes the row. Subsequent dispatches fall back to env var or signal-only.
- `POST /elevenlabs/credentials/test` — proxies `GET https://api.elevenlabs.io/v1/user` using the stored key. Returns `{ ok: boolean, statusCode: number, subscription?: { tier: string, characterCount: number, characterLimit: number, nextResetUnix: number } }` and persists the outcome to `last_test_ok_at` + `last_test_status_code`.
- `GET /elevenlabs/voices` — proxies `GET https://api.elevenlabs.io/v1/voices` using the stored key. Cached in-memory for 1 hour per agent. Returns `{ voices: Array<{ voiceId: string, name: string, labels?: object }> }`.

All endpoints MUST require the `x-nexus-secret` header.

#### Scenario: GET masks the key
Given a credential is stored with `api_key=secret-key-123`
When `GET /elevenlabs/credentials` is called
Then the response includes `hasKey: true` and the strings `"secret-key-123"`, `"value_encrypted"`, and any prefix/suffix of the key are NOT present anywhere in the body

#### Scenario: Test probe records outcome
Given a stored key that ElevenLabs returns 401 for
When `POST /elevenlabs/credentials/test` runs
Then the response is `{ ok: false, statusCode: 401 }` and the row's `last_test_status_code` is updated to `401`

#### Scenario: Voice-list cache hit
Given the voice list was fetched at time T and the cache TTL is 1h
When `GET /elevenlabs/voices` is called at time T+30min
Then the response is served from cache without an upstream HTTP call

### Requirement: The dashboard MUST provide a credential management page at /integrations/elevenlabs
The page MUST render:
- A masked-input field for the API key that always shows placeholder bullets when a key is stored, accepts paste to overwrite, and never displays the stored value
- A voice dropdown populated by `GET /elevenlabs/voices` with each entry showing `name` and the first label value (e.g., language)
- A "Test connection" button that calls `POST /elevenlabs/credentials/test` and renders the resulting status code, plus a quota summary `${characterCount} / ${characterLimit} chars` when subscription data is returned
- A "Save" button that issues a single `PATCH /elevenlabs/credentials` with both the key (if changed) and voice
- A "Delete credentials" link that issues `DELETE /elevenlabs/credentials` after a confirmation prompt
- A header indicating which agent the page is showing credentials for

The page SHALL be linked from the dashboard's primary navigation under an "Integrations" section.

#### Scenario: First-load empty state
Given no `elevenlabs_credentials` row exists for the local agent
When the user opens `/integrations/elevenlabs`
Then the page renders an empty form with a placeholder describing where to obtain an ElevenLabs API key

#### Scenario: Save + test happy path
Given the user pastes a valid key and selects a voice
When they click Save and then Test
Then the row is persisted, the test result shows `ok: true`, and the quota summary renders below the button

#### Scenario: 401 surfaces clearly
Given the user pastes a key that ElevenLabs rejects
When they click Test
Then the page renders "Status: 401 — invalid or expired API key" and does NOT show a quota summary

## Scope
- **IN**: Encrypted DB storage (api_key + voice metadata), per-agent rows, GET/PATCH/POST/DELETE/voice-list HTTP endpoints, `/v1/user` test probe, `/v1/voices` cached proxy, `/integrations/elevenlabs` dashboard page with masked input + voice dropdown + test panel, env-var fallback for unmigrated agents, rotate-without-restart semantics, Bun unit tests for endpoints + encryption round-trip, one Playwright e2e covering save/test
- **OUT**: Multi-key pool with quota-exhaust auto-rotation (Shape C — explicitly deferred), usage timeline + `tts_usage_polls` table (lands in `add-elevenlabs-usage`), notification-history filtered to TTS-channel deliveries (lands in `add-elevenlabs-dashboard`), voice preview / sample-synthesis button, log-redaction audit (the key is already not logged), federated cross-agent management (each agent owns its own row), API-key validation regex (we let ElevenLabs decide via the test probe)

## Impact
| Area | Change |
|------|--------|
| Database | New table `elevenlabs_credentials`. New migration. |
| Agent | New `/elevenlabs/credentials*` route group (4 endpoints) + `/elevenlabs/voices` (1 endpoint, cached). TTS channel reads DB row before env. |
| Dashboard | New page `/integrations/elevenlabs` + supporting actions and components (masked input, voice dropdown, test panel). New nav entry under "Integrations". |
| Crypto | None — reuses existing `encrypt`/`decrypt` and master-key resolution. |
| Existing callers | TTS channel adds an `await db.query.elevenlabsCredentials...` lookup before the env-var read. Backwards compatible (env still works). |
| Migration | None forced — env-var fallback preserves current behavior until the user opts in by saving a key in the dashboard. |

## Risks
| Risk | Mitigation |
|------|-----------|
| Master encryption key not set on homelab → encrypt() throws → save fails silently | PATCH endpoint returns HTTP 400 with explicit `"encryption key not configured"` error; dashboard renders the error inline |
| `/v1/voices` fetch slow → dashboard render stalls | Proxy endpoint caches the voice list for 1 hour per agent; UI fast-fails with a text-input fallback if the proxy returns 5xx |
| Agent reads DB on every dispatch → DB load | Notifications fire <1/min in normal use; cost is one indexed `SELECT` per fire — well below the threshold that warrants caching |
| User pastes an incorrectly-formatted key → confusing 401 from ElevenLabs | The Test button surfaces the raw `statusCode` so the user can self-diagnose; we explicitly do NOT validate key format ourselves to avoid drift if ElevenLabs changes it |
| Dashboard manages credentials for non-local agents (e.g., macbook from homelab UI) | Out of scope; v1 only manages the LOCAL agent's row. Cross-agent management deferred to a later spec |
| Race between concurrent PATCHes from two browser tabs | Last-write-wins on `updated_at`; acceptable for a single-user homelab tool |
