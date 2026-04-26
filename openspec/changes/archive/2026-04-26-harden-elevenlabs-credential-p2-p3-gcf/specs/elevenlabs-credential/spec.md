# elevenlabs-credential Specification

## Purpose
Hardening follow-up to `add-elevenlabs-credential` — closes 17 P2/P3/GCF findings raised by the post-merge security and architecture review while preserving every behavioral guarantee of the original spec.

## ADDED Requirements

### Requirement: PATCH input MUST validate against the canonical Zod schema
`handlePatchCredentials` MUST call `elevenlabsPatchInput.parse(body)` (or `safeParse` with explicit error mapping) instead of hand-rolling type guards. Empty-string `apiKey` MUST be rejected with HTTP 400. The schema's strict/passthrough posture as declared in `@nexus/core` MUST be honored.

#### Scenario: Empty-string apiKey rejected
Given a PATCH body `{"apiKey":""}`
When the handler runs
Then the response is HTTP 400 with body `{"error":"invalid input","detail":<zod issue>}` and no row is written

#### Scenario: Valid input still works
Given a PATCH body `{"apiKey":"xi-real-12345","voiceId":"v1"}`
When the handler runs
Then the row is encrypted and persisted; the masked GET shape reflects the change

### Requirement: ElevenLabs runtime state SHALL live in a single shared module
A new module `apps/agent/src/credentials/elevenlabs-runtime.ts` MUST export `setElevenlabsRuntime`, `getElevenlabsEncryptionKey`, and `getElevenlabsDb`. Both `routes/elevenlabs-credentials.ts` and `notifications/channels/tts.ts` MUST import getters from this module. The previous module-level `elevenlabsKeyRef` (in routes) and `ambientDb`/`setTtsDb`/`resetTtsDb` (in tts.ts) MUST be removed. `startServer()` calls `setElevenlabsRuntime` once during init.

#### Scenario: Single setter installs both
Given `startServer()` runs with `encryptionKey=K` and `db=D`
When TTS dispatch runs after init
Then `tts.ts` reads K and D from `elevenlabs-runtime`'s getters; the bifurcated `setTtsDb` and `elevenlabsKeyRef` no longer exist

#### Scenario: Manager does not install ambient state
Given `NotificationManager` constructor receives `db`
When the manager initializes
Then it does NOT call any setter on `tts.ts`; `tts.ts` derives `db` solely from `getElevenlabsDb()`

### Requirement: HTTP dispatch SHALL go through tryHandleElevenlabsRoute()
A new `apps/agent/src/server-routes-elevenlabs.ts` MUST export `tryHandleElevenlabsRoute(request, url, db)` returning `Response | Promise<Response> | null` and handle all 5 elevenlabs routes. `server-request-handler.ts` MUST replace its inlined branch with a single call to `tryHandleElevenlabsRoute()`. The orphan `apps/agent/src/routes/elevenlabs-builder.ts` MUST be deleted.

#### Scenario: Inlined branch replaced
Given `server-request-handler.ts` previously had ~100 LOC of `if (url.pathname === "/elevenlabs/credentials" ...)` branches
When the refactor lands
Then those branches are removed, replaced by `const elevenlabsResult = tryHandleElevenlabsRoute(request, url, db); if (elevenlabsResult !== null) return elevenlabsResult;`

#### Scenario: Orphan builder removed
Given `apps/agent/src/routes/elevenlabs-builder.ts` exists with no callers
When the refactor lands
Then the file is deleted and no test or runtime reference is broken

### Requirement: Voice list cache MUST invalidate on credential mutation AND cap its size
`elevenlabs-voices.ts` MUST expose `invalidateVoiceCache(agentId: string): void`. `handlePatchCredentials` MUST call it when `apiKey` is in the patched fields. `handleDeleteCredentials` MUST call it unconditionally. The cache itself MUST be capped at 32 entries with LRU eviction.

#### Scenario: PATCH-with-apiKey invalidates
Given a cached voice list for agent `omarchy` populated under the old apiKey
When PATCH /elevenlabs/credentials writes a new apiKey
Then `invalidateVoiceCache("omarchy")` runs and the next GET /elevenlabs/voices fetches fresh from upstream

#### Scenario: DELETE invalidates
Given a cached voice list for agent X exists
When DELETE /elevenlabs/credentials runs
Then the cache entry for X is removed; subsequent GET /elevenlabs/voices returns 400 (no credential) instead of stale voices

#### Scenario: Cache cap enforced
Given the cache holds 32 entries
When a 33rd unique agentId is inserted
Then the least-recently-used entry is evicted

### Requirement: Network-error status code MUST surface as a recognizable signal
When `handleTestConnection`'s upstream fetch throws (network failure, DNS, timeout), `last_test_status_code` MUST be persisted as `null`, and the response body MUST include `{ ok: false, statusCode: null, error: "network" }`. The dashboard's `TestConnectionPanel` MUST render `null` as `"Network error — could not reach api.elevenlabs.io"`.

#### Scenario: Network failure surfaces as null + label
Given the upstream fetch throws ETIMEDOUT
When the test endpoint runs
Then the row's `last_test_status_code = NULL`, the response is `{ ok: false, statusCode: null, error: "network" }`, and the dashboard renders the friendly label

### Requirement: TTS error logs MUST scrub headers before serializing
A `scrubFetchError(err: unknown): unknown` helper alongside `tts.ts` MUST filter HTTP request/response header fields out of error objects before they reach `logger.warn`. Specifically, any nested key matching `xi-api-key` (case-insensitive) at any depth MUST be removed.

#### Scenario: Header field stripped
Given an error object with `headers: { "xi-api-key": "secret" }` nested at any depth
When the channel logs the error
Then the serialized log entry contains no key matching `xi-api-key` at any depth

### Requirement: Decrypt-fallback to env MUST emit an auditable signal
`resolveCredential` in `tts.ts` MUST call `lifecycleBus.emit("CredentialDecryptFallback", { agentId, source: "tts" })` (or the existing namespace's equivalent) before falling back to env when the DB-row decrypt path fails.

#### Scenario: Fallback emits event
Given a stored row with corrupted ciphertext
When `resolveCredential` runs and decrypt throws
Then `lifecycleBus.emit("CredentialDecryptFallback", ...)` fires once before the env fallback returns

### Requirement: Server-action error path MUST whitelist agent error codes
`saveCredentials` in the dashboard MUST map known agent error strings to user-facing messages and surface unknown errors as a generic `"Could not save credentials. Check the agent log."` while still logging the raw text server-side.

#### Scenario: Known error maps to friendly text
Given the agent returns 400 with body `{"error":"encryption key not configured"}`
When `saveCredentials` runs
Then the thrown Error message is `"Encryption key not configured on the agent. Set NEXUS_ENCRYPTION_KEY and restart."` and the raw text is logged server-side

#### Scenario: Unknown error sanitized
Given the agent returns 500 with body `{"error":"<some new code>"}`
When `saveCredentials` runs
Then the thrown Error message is `"Could not save credentials. Check the agent log."` (no echo of the agent's raw body)

### Requirement: Test endpoint MUST have unit coverage for non-leakage and decrypt failure
`apps/agent/src/routes/elevenlabs-credentials.test.ts` MUST add tests proving:
1. POST /test never echoes the decrypted apiKey, even on 200 with subscription data
2. POST /test on a row with corrupted ciphertext (mocked `decrypt` throw) returns HTTP 500 with `{"error":"could not decrypt stored credential"}` and does NOT propagate the decrypt error message
3. POST /test on missing row returns HTTP 400 with `{"error":"no credential stored"}`

#### Scenario: Test response masks key
Given a stored apiKey `xi-secret-AAA` and upstream returns 200 with subscription data
When POST /elevenlabs/credentials/test runs
Then the response body string never contains `xi-secret-AAA`, `value_encrypted`, or any prefix/suffix of the key

#### Scenario: Decrypt failure mapped
Given a stored row with corrupted ciphertext
When POST /test runs
Then the response is HTTP 500 with body `{"error":"could not decrypt stored credential"}` (no upstream call attempted, no decrypt error message exposed)

### Requirement: FK cascade behavior SHALL have an integration smoke test
A new integration test MUST exercise the actual ON DELETE CASCADE on `agent_id`: insert agent → insert elevenlabs_credentials row → delete agent → assert row gone. The test MUST run against a real DB (project's integration DB) and SHALL skip when `POSTGRES_URL` is unset.

#### Scenario: Cascade fires
Given an agent row and matching elevenlabs_credentials row exist
When the agent row is DELETEd
Then the elevenlabs_credentials row is removed by the FK cascade

### Requirement: MaskedKeyInput placeholder MUST never bind to value
A regression test MUST assert that `<input>.value` is empty on first render with `hasKey={true}`, and that the bullet placeholder string never appears in the `value` attribute at any time.

#### Scenario: First render with stored key
Given the component mounts with `hasKey={true}`
When the rendered DOM is inspected
Then `inputElement.value === ""` and the bullet string appears only in the `placeholder` attribute
