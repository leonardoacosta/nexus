# Proposal: Harden ElevenLabs Credential — P2/P3/GCF Follow-ups

## Change ID
`harden-elevenlabs-credential-p2-p3-gcf`

## Summary
Address the 17 P2/P3/GCF findings raised by the post-merge security + architecture audit of `add-elevenlabs-credential` (commits 6927c93–a07657e). Tightens input validation, factors out the bifurcated singletons that made the route↔notification boundary inverted, extracts the inlined dispatch into a `tryHandleElevenlabsRoute()` sub-dispatcher matching the OAuth pool's pattern, plus targeted defense-in-depth (voice-cache invalidation, header-redaction in error logs, FK-cascade smoke test).

## Context
- Extends: `apps/agent/src/routes/elevenlabs-credentials.ts` (Zod parse, status-0 mapping, voice cache invalidation hook, test-endpoint coverage)
- Extends: `apps/agent/src/routes/elevenlabs-voices.ts` (LRU cap, invalidation hook called by credential mutations)
- Extends: `apps/agent/src/notifications/channels/tts.ts` (header redaction in err logs, decrypt-fallback audit signal, removes upward import)
- Extends: `apps/agent/src/server-request-handler.ts` (replaces inlined elevenlabs branch with `tryHandleElevenlabsRoute()`)
- Extends: `apps/nextjs/src/app/actions/elevenlabs-credentials.ts` (whitelists agent error codes)
- New: `apps/agent/src/credentials/elevenlabs-runtime.ts` — unified runtime module replacing the bifurcated `elevenlabsKeyRef` (in routes) + `ambientDb` (in tts.ts)
- New: `apps/agent/src/server-routes-elevenlabs.ts` — sub-dispatcher mirroring `server-routes-credentials.ts`
- DELETE: `apps/agent/src/routes/elevenlabs-builder.ts` — orphan; nothing imports `buildElevenlabsRoutes()`
- Related: archived `2026-04-26-add-elevenlabs-credential` (the spec being hardened)
- Related: `apps/agent/src/routes/credentials/shared.ts` (pattern source for unified runtime ref)

## Motivation
The audit produced 18 findings across the integration shipped today: 0 P1, 7 P2, 8 P3, 3 GCF. None block production, but four threads recur across both reviewers and warrant a focused follow-up:

1. **Input validation drift.** The PATCH handler defines its own type guard instead of calling `elevenlabsPatchInput.parse()` from the Zod schema in `@nexus/core`. The Zod schema enforces `apiKey.min(1)` but the runtime never invokes it, so an empty-string apiKey gets encrypted, stored, and reports `hasKey: true` while every upstream call 401s. The schema-as-contract value is wasted.
2. **Bifurcated singletons + layering inversion.** `elevenlabsKeyRef` (set by `startServer`) lives in the routes layer; `ambientDb` (set by `NotificationManager`) lives in the channel layer. The TTS channel imports `getElevenlabsEncryptionKey` *upward* from the routes module — exactly the inversion the existing OAuth pool avoided via `routes/credentials/shared.ts`. A single new `apps/agent/src/credentials/elevenlabs-runtime.ts` module owned by both consumers cleans up the inversion and the implicit ordering contract.
3. **Dispatcher drift + orphan code.** OAuth credentials have a clean `tryHandleCredentialRoute()` sub-dispatcher; ElevenLabs was inlined as five if-blocks in `server-request-handler.ts` (+100 LOC). Worse, `elevenlabs-builder.ts` exports `buildElevenlabsRoutes()` that no caller invokes — phantom code that lies about how the routes are wired. Either extract the sub-dispatcher or delete the builder; we do both (extract, delete builder).
4. **Defense-in-depth gaps.** Voice cache stale on key rotation, status-code 0 surfaced as "0" to the dashboard, network errors with potentially echoed headers logged verbatim, no test coverage for the path that decrypts and exfiltrates the key (the `/test` endpoint), and no smoke test that the FK cascade actually fires. None alone are exploitable; together they form the kind of latent surface that bites in 6 months.

The two GCFs we include here (FK cascade smoke test + MaskedKeyInput placeholder regression) are tiny and protect against future refactors silently breaking the security contract. The third GCF (multi-agent dashboard fan-out) is design work for a later spec and is explicitly out of scope.

## Requirements

### Requirement: PATCH input MUST validate against the canonical Zod schema
`handlePatchCredentials` MUST call `elevenlabsPatchInput.parse(body)` (or `safeParse` with explicit error mapping) instead of hand-rolling type guards. Empty-string `apiKey` MUST be rejected with HTTP 400. Unknown fields MUST be rejected (or stripped) per the schema's `.strict()` / `.passthrough()` posture — preserve whichever the schema currently declares.

#### Scenario: Empty-string apiKey rejected
Given a PATCH body `{"apiKey":""}`
When the handler runs
Then the response is HTTP 400 with body `{"error":"invalid input","detail":<zod issue>}` and no row is written

#### Scenario: Unknown field rejected
Given a PATCH body `{"apiKey":"valid","extraField":"x"}`
When the handler runs
Then the response is HTTP 400 (if the schema is strict) OR the unknown field is dropped (if passthrough) — match whatever the canonical schema specifies

#### Scenario: Valid input still works
Given a PATCH body `{"apiKey":"xi-real-12345","voiceId":"v1"}`
When the handler runs
Then the row is encrypted and persisted; the masked GET shape reflects the change

### Requirement: ElevenLabs runtime state SHALL live in a single shared module
A new module `apps/agent/src/credentials/elevenlabs-runtime.ts` MUST export:
- `setElevenlabsRuntime({ encryptionKey?: Buffer; db?: Db }): void`
- `getElevenlabsEncryptionKey(): Buffer | undefined`
- `getElevenlabsDb(): Db | undefined`

Both `routes/elevenlabs-credentials.ts` and `notifications/channels/tts.ts` MUST import getters from this module. The module MUST NOT be imported from anywhere outside `apps/agent/src/`. The previous module-level `elevenlabsKeyRef` (in routes) and `ambientDb`/`setTtsDb`/`resetTtsDb` (in tts.ts) MUST be removed.

`startServer()` MUST call `setElevenlabsRuntime({ encryptionKey, db })` once during init. `NotificationManager` MUST NOT install ambient state — the channel reads from the runtime module directly.

#### Scenario: Single setter installs both
Given `startServer()` runs with `encryptionKey=K` and `db=D`
When TTS dispatch runs after init
Then `tts.ts` reads K and D from `elevenlabs-runtime`'s getters; the bifurcated `setTtsDb` and `elevenlabsKeyRef` no longer exist

#### Scenario: Manager does not install ambient state
Given `NotificationManager` constructor receives `db`
When the manager initializes
Then it does NOT call any setter on `tts.ts`; `tts.ts` derives `db` solely from `getElevenlabsDb()`

### Requirement: HTTP dispatch SHALL go through tryHandleElevenlabsRoute()
A new `apps/agent/src/server-routes-elevenlabs.ts` MUST export `tryHandleElevenlabsRoute(request, url, db)` returning `Response | Promise<Response> | null`. It MUST handle all 5 elevenlabs routes (GET/PATCH/DELETE /elevenlabs/credentials, POST /elevenlabs/credentials/test, GET /elevenlabs/voices). `server-request-handler.ts` MUST replace the inlined branch (~100 LOC) with a single call to `tryHandleElevenlabsRoute()` mirroring the existing `tryHandleCredentialRoute()` site.

`apps/agent/src/routes/elevenlabs-builder.ts` MUST be deleted — `buildElevenlabsRoutes()` has no callers and the dispatcher pattern obviates it.

#### Scenario: Inlined branch replaced
Given `server-request-handler.ts` previously had ~100 LOC of `if (url.pathname === "/elevenlabs/credentials" ...)` branches
When the refactor lands
Then those branches are removed, replaced by `const elevenlabsResult = tryHandleElevenlabsRoute(request, url, db); if (elevenlabsResult !== null) return elevenlabsResult;`

#### Scenario: Orphan builder removed
Given `apps/agent/src/routes/elevenlabs-builder.ts` exists with no callers
When the refactor lands
Then the file is deleted and no test or runtime reference is broken

### Requirement: Voice list cache MUST invalidate on credential mutation AND cap its size
`elevenlabs-voices.ts` MUST expose `invalidateVoiceCache(agentId: string): void`. `handlePatchCredentials` MUST call it whenever `apiKey` is in the patched fields. `handleDeleteCredentials` MUST call it unconditionally. The cache itself MUST be capped at 32 entries with LRU eviction (or a comparable bounded structure).

#### Scenario: PATCH-with-apiKey invalidates
Given a cached voice list for agent `omarchy` populated at T
And the cached list reflects the upstream response under the OLD apiKey
When PATCH /elevenlabs/credentials writes a new apiKey at T+1min
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
When `handleTestConnection`'s upstream fetch throws (network failure, DNS, timeout), `last_test_status_code` MUST be persisted as `null` (not `0`), and the response body MUST include `{ ok: false, statusCode: null, error: "network" }`. The dashboard's `TestConnectionPanel` MUST render `null` as `"Network error — could not reach api.elevenlabs.io"` instead of `"Status: 0"`.

#### Scenario: Network failure surfaces as null + label
Given the upstream fetch throws ETIMEDOUT
When the test endpoint runs
Then the row's `last_test_status_code = NULL`, the response is `{ ok: false, statusCode: null, error: "network" }`, and the dashboard renders the friendly label

### Requirement: TTS error logs MUST scrub headers before serializing
In `tts.ts`, before any `logger.warn({ err }, ...)` call where `err` may originate from `fetchWithTimeout`, the implementation MUST filter or rewrite `err` to remove any field that could carry HTTP request/response headers (notably the `xi-api-key` header that the channel inserted). A helper `scrubFetchError(err: unknown): unknown` SHALL live alongside the channel and produce a logger-safe shape.

#### Scenario: Header field stripped
Given an error object with a nested `headers: { "xi-api-key": "secret" }`
When the channel logs the error
Then the serialized log entry contains no key matching `xi-api-key` (case-insensitive) at any depth

### Requirement: Decrypt-fallback to env MUST emit an auditable signal
`resolveCredential` in `tts.ts` MUST call a counter or one-shot lifecycle event when the DB-row decrypt path fails and the channel falls back to env. A new `lifecycleBus.emit("CredentialDecryptFallback", { agentId, source: "tts" })` (or equivalent — match the existing event namespace) SHALL fire, allowing a dashboard widget or log query to count fallbacks per day.

#### Scenario: Fallback emits event
Given a stored row with corrupted ciphertext
When `resolveCredential` runs and decrypt throws
Then `lifecycleBus.emit("CredentialDecryptFallback", ...)` fires once before the env fallback returns

### Requirement: Server-action error path MUST whitelist agent error codes
`apps/nextjs/src/app/actions/elevenlabs-credentials.ts`'s `saveCredentials` MUST NOT pass agent response text directly to a thrown `Error` for DOM rendering. Instead, it MUST map known agent error strings (`"encryption key not configured"`, `"invalid input"`, etc.) to user-facing messages, and surface unknown errors as a generic `"Could not save credentials. Check the agent log."` while still logging the raw text server-side for diagnostics.

#### Scenario: Known error maps to friendly text
Given the agent returns 400 with body `{"error":"encryption key not configured"}`
When `saveCredentials` runs
Then the thrown Error message is `"Encryption key not configured on the agent. Set NEXUS_ENCRYPTION_KEY and restart."` and the raw text is logged server-side

#### Scenario: Unknown error sanitized
Given the agent returns 500 with body `{"error":"<some new code>"}`
When `saveCredentials` runs
Then the thrown Error message is `"Could not save credentials. Check the agent log."` (no echo of the agent's raw body)

### Requirement: Test endpoint MUST have unit coverage for non-leakage and decrypt failure
`apps/agent/src/routes/elevenlabs-credentials.test.ts` MUST add three new tests:
1. POST /test never echoes the decrypted apiKey in the response body, even when upstream returns 200 with subscription data
2. POST /test on a row whose ciphertext is corrupted (mock `decrypt()` to throw) returns HTTP 500 with `{"error":"could not decrypt stored credential"}` and does NOT propagate the decrypt error message
3. POST /test on missing row returns HTTP 400 with `{"error":"no credential stored"}`

#### Scenario: Test response masks key
Given a stored apiKey `xi-secret-AAA`
And upstream returns 200 with `{"subscription":{"tier":"pro","character_count":100,"character_limit":10000,"next_character_count_reset_unix":...}}`
When POST /elevenlabs/credentials/test runs
Then the response body string never contains `xi-secret-AAA`, `value_encrypted`, or any prefix/suffix of the key

#### Scenario: Decrypt failure mapped
Given a stored row with corrupted ciphertext
When POST /test runs
Then the response is HTTP 500 with body `{"error":"could not decrypt stored credential"}` (no upstream call attempted, no decrypt error message exposed)

### Requirement: FK cascade behavior SHALL have an integration smoke test
A new integration test (`packages/db/__tests__/elevenlabs-cascade.test.ts` or `apps/agent/src/credentials/elevenlabs-cascade.test.ts` — match the project's integration-test home) MUST exercise the actual ON DELETE CASCADE on `agent_id`:
1. Insert agent row
2. Insert elevenlabs_credentials row keyed on that agent
3. DELETE the agent row
4. Assert the elevenlabs_credentials row is gone

The test MUST run against a real DB (not a mock) — either the project's integration test DB or a temp Postgres instance.

#### Scenario: Cascade fires
Given an agent row and matching elevenlabs_credentials row exist
When the agent row is DELETEd
Then the elevenlabs_credentials row is removed by the FK cascade

### Requirement: MaskedKeyInput placeholder MUST never bind to value
A new test in `apps/nextjs/src/components/MaskedKeyInput.test.tsx` (or a Playwright e2e step in the existing integration spec) MUST assert that `<input>.value` is the empty string on first render even when `hasKey={true}`, and that the bullet placeholder string never equals the input's value at any time. This guards against future refactors that bind the placeholder to the value attribute by mistake.

#### Scenario: First render with stored key
Given the component mounts with `hasKey={true}`
When the rendered DOM is inspected
Then `inputElement.value === ""` and the bullet string `"••••••••"` (or whatever placeholder is configured) appears only in the `placeholder` attribute, never in the `value` attribute

## Scope
- **IN**: Zod parse at PATCH boundary, unified `elevenlabs-runtime.ts` module replacing the two singletons, `tryHandleElevenlabsRoute()` extraction + orphan-builder deletion, voice-cache invalidation hooks + LRU cap, network-error mapped to `null`+label, header-scrubbing helper for tts.ts logs, lifecycle event on decrypt fallback, server-action error whitelist, unit tests for /test endpoint (non-leakage + decrypt-throw + missing row), FK cascade integration test, MaskedKeyInput placeholder regression test
- **OUT**: Multi-agent dashboard fan-out design (third GCF — that's a design exercise that belongs in `add-elevenlabs-dashboard`, not implementation work in a hardening spec), Sentry breadcrumb redaction (defense-in-depth opportunity that the audit flagged but didn't observe an actual leak — defer to a broader telemetry-redaction sweep), key-version migration story for `encryption_key_id` (deferred until we actually need to rotate the master key), schema-divergence comment between `credentials` and `elevenlabs_credentials` (P3 doc nit — fold into `/workflow:write-docs` later)

## Impact
| Area | Change |
|------|--------|
| Agent runtime | New `credentials/elevenlabs-runtime.ts`. Consolidates two singletons into one. New `server-routes-elevenlabs.ts` sub-dispatcher. Inlined branch removed from `server-request-handler.ts`. Orphan `routes/elevenlabs-builder.ts` deleted. PATCH validates via Zod. Voice cache gains LRU cap + invalidation hooks. Test endpoint maps network errors to `null`+`error: "network"`. tts.ts scrubs error headers before logging and emits `CredentialDecryptFallback` lifecycle event. |
| Dashboard | `actions/elevenlabs-credentials.ts` whitelists known agent error codes. `TestConnectionPanel.tsx` renders `null` status as `"Network error..."`. New `MaskedKeyInput.test.tsx` regression test. |
| Database | No schema change. New integration test exercises the existing FK cascade. |
| Tests | +5 unit tests in `routes/elevenlabs-credentials.test.ts` (Zod rejection, /test mask, /test decrypt-throw, /test missing row, voice cache invalidation). +1 integration test (FK cascade). +1 component test (MaskedKeyInput). |
| Lifecycle bus | New event `CredentialDecryptFallback` (additive — existing handlers ignore unknown events). |
| Public contracts | `last_test_status_code` shape extends from `number \| null` (was `number` defaulting to 0 on network err). API consumers (just the dashboard) MUST handle the `null` case. |

## Risks
| Risk | Mitigation |
|------|-----------|
| Singleton refactor breaks the existing dispatch path mid-flight | All four phases land in one `/apply:all` wave; no half-state. The runtime test suite (existing 17 tests across encryption + routes + channel) catches regressions before push. |
| `null` status code breaks downstream parsing | The Zod response schema in `@nexus/core` updates in lockstep; the dashboard component is the only consumer and renders the new label. |
| Sub-dispatcher extraction subtly changes route order | The new `tryHandleElevenlabsRoute()` is invoked at the SAME position in `server-request-handler.ts` that the inlined branch occupied — no order shift. |
| `lifecycleBus.emit("CredentialDecryptFallback")` floods if a row's ciphertext is permanently corrupt | The event fires once per dispatch attempt; downstream consumers (none yet) can debounce. The decrypt-fallback path is itself rare; no cascade risk. |
| Deleting `elevenlabs-builder.ts` accidentally breaks an unseen import | Pre-deletion grep confirms zero callers. CI typecheck catches any dangling reference. |
| Test for `/test` endpoint requires mocking `fetchWithTimeout` AND `decrypt` simultaneously | The existing test file already mocks `fetchWithTimeout`; adding a `decrypt` mock follows the same `mock.module` pattern. |
| FK-cascade integration test needs a live DB on CI | Only runs when `POSTGRES_URL` is set in the env; gated like the existing integration tests in `packages/db`. CI without a DB skips with a clear log line. |
