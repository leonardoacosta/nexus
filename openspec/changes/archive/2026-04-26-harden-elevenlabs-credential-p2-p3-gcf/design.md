# Design Notes — harden-elevenlabs-credential-p2-p3-gcf

## Why a design.md
The hardening spec touches 11 files across three layers (DB, agent, dashboard), introduces two new modules (`elevenlabs-runtime.ts`, `server-routes-elevenlabs.ts`), changes a public response shape (`statusCode: number → number | null`), and adds a new lifecycle event. Capturing the rationale once here prevents the implementation pass from re-litigating decisions that the audit already settled.

## Why a single runtime module instead of two singletons

The audit flagged `elevenlabsKeyRef` (in `routes/elevenlabs-credentials.ts`) and `ambientDb`/`setTtsDb` (in `notifications/channels/tts.ts`) as parallel module-level singletons installed by two different callers (`startServer` and `NotificationManager`). The TTS channel imports a getter *upward* from the routes layer — exactly the inversion the OAuth pool already solved.

Three reasons to consolidate:

1. **Implicit ordering contract**. If a future entry point boots `NotificationManager` before `startServer` (or only one of the two), TTS dispatch silently degrades to env-var fallback with only a `logger.warn` as the signal. Having one setter called once at startup eliminates the contract.
2. **Layering inversion**. `apps/agent/src/notifications/` should not depend on `apps/agent/src/routes/`. The runtime module lives under `apps/agent/src/credentials/` (where the OAuth `shared.ts` already lives), and both consumers (`routes/elevenlabs-credentials.ts` and `notifications/channels/tts.ts`) import from it. Layering becomes: `runtime ← {routes, notifications}` — no upward reach.
3. **Test surface shrinks**. The bifurcated state required two reset helpers (`resetTtsDb` for tests). One module has one reset helper.

The shape mirrors `routes/credentials/shared.ts`'s `poolRef.current` pattern. We don't reuse `poolRef` itself because OAuth pool semantics (leasing, fingerprinting, primary selection) don't apply — only the runtime-state-singleton pattern does.

## Why extract `tryHandleElevenlabsRoute()` instead of inlining or building a builder

The OAuth credentials are dispatched via `tryHandleCredentialRoute()` in `server-routes-credentials.ts`. The new ElevenLabs routes were inlined as five if-blocks in `server-request-handler.ts` (~100 LOC). The architecture review flagged the dispatcher drift.

There are three plausible shapes:

| Shape | Pros | Cons | Verdict |
|---|---|---|---|
| **Keep inlined** | Zero refactor cost | `server-request-handler.ts` grows past 500 lines; future routes inherit the same drift | ❌ |
| **`tryHandleElevenlabsRoute()` sub-dispatcher** (chosen) | Matches OAuth pattern; ~100 LOC removed from the main dispatcher; isolated test surface | One new file to maintain | ✅ |
| **Wire the existing `buildElevenlabsRoutes()` builder** | Reuses the in-progress builder migration | Builder migration isn't fleet-wide yet; this would be a one-off; orphan builder lies about wiring today | ❌ |

The orphan `routes/elevenlabs-builder.ts` exports a `buildElevenlabsRoutes()` that nobody imports — it's dead code that suggests a different wiring than reality. Deleting it is not just cleanup; it's removing a future-contributor trap. The dispatcher migration is a separate broader effort; we don't accelerate it just for one feature.

## Why `statusCode: number | null` instead of `0` for network errors

`/test` proxies the upstream call. When upstream returns 401, `statusCode = 401` makes sense. When the fetch *throws* (DNS, timeout, connection refused), there is no HTTP status — there was no HTTP exchange. Persisting `0` and rendering `"Status: 0"` lies about what happened: it implies a status code from the wire when in fact the wire never spoke.

The honest type is `number | null` where `null` means "no HTTP response was received." The dashboard renders this as `"Network error — could not reach api.elevenlabs.io"` which:

- Tells the user the actual failure mode (network, not auth or quota)
- Disambiguates from `403` (forbidden) or `502` (bad gateway) which CAN result in a real status from a proxy
- Doesn't require the dashboard to know the difference between `0` and other valid-looking-but-meaningless status numbers

This is a small public-contract change. The only consumer is the dashboard, which we update in the same commit. Future consumers (the upcoming `add-elevenlabs-usage` spec's poller) get the cleaner shape from day one.

## Why a `scrubFetchError` helper instead of a structured logger setting

The audit observed that `tts.ts` passes `err` verbatim to `logger.warn({ err }, ...)` after a `fetchWithTimeout` failure. If the error object ever carries the request headers (some fetch wrappers attach the failed request for diagnostics), the `xi-api-key` header could appear in logs and downstream telemetry (Sentry breadcrumbs, log aggregator).

Three remediation options:

| Option | What | Trade-off |
|---|---|---|
| **Helper at call site** (chosen) | `scrubFetchError(err)` filters known-bad keys before logging | Local, explicit, no logger config to forget |
| **Logger redactor** (e.g., pino's `redact`) | Configure the logger globally to drop `xi-api-key` paths | Works for THIS logger, not for `captureException(err)` calls to Sentry which use a different code path |
| **Wrap fetchWithTimeout** | Make `fetchWithTimeout` itself never embed headers in errors | Touches a shared utility used by many callers; broader blast radius |

The local helper is the smallest fix that closes the immediate concern. A future broader pass (`telemetry-redaction-sweep`) can move this into the logger config and Sentry beforeBreadcrumb hook — but that's out of scope here.

## Why a `CredentialDecryptFallback` lifecycle event

When a row's ciphertext is corrupted (key rotation drift, manual SQL surgery, etc.) `resolveCredential` falls back to env. Today the only signal is a `logger.warn`, which:

- Doesn't surface in the dashboard
- Isn't queryable for "how often did this happen this week?"
- Provides no audit trail if an attacker engineers a fallback to seize control of TTS dispatch

Emitting a lifecycle event gives downstream consumers (the upcoming usage dashboard, log queries, future monitoring) a structured signal. The event is additive — existing handlers ignore unknown event types — so introducing it carries no migration cost.

The event name `CredentialDecryptFallback` is generic enough to cover future credential types (the OAuth pool could emit it too on its own decrypt failures). The payload `{ agentId, source: "tts" }` lets a counter group by source if other channels eventually emit it.

## Why GCFs 1 and 2 land here, GCF 3 doesn't

The architecture audit produced 3 GCFs:

| GCF | What | Decision |
|---|---|---|
| FK cascade smoke test | Verify `ON DELETE CASCADE` actually fires by inserting + deleting | ✅ IN — tiny addition, real protection against future schema changes silently breaking the cascade |
| `MaskedKeyInput.value !== bullet` regression test | Assert the placeholder never binds to value | ✅ IN — tiny addition, protects the security contract of the form |
| Multi-agent dashboard fan-out design | Design a path from single-agent to multi-agent dashboard surfaces | ❌ OUT — design exercise for `add-elevenlabs-dashboard`, not implementation work for a hardening spec |

The two we include cost ~30 LOC each and turn an existing security-critical assumption into something CI verifies. The third is a coherent design discussion that belongs in the next-spec discovery phase; folding it into the hardening spec would muddy scope.

## Test strategy notes

- **`/test` endpoint coverage** is the largest gap the audit flagged. The new tests (mask invariant, decrypt-throw mapping, missing-row 400) cover every visible code path of `handleTestConnection`. Mock both `fetchWithTimeout` and `decrypt` to exercise the upstream + crypto branches without external dependencies.
- **FK cascade test** runs against a real DB. We gate it on `process.env.POSTGRES_URL` being set so CI without a DB skips with a clear log. The integration-test-home convention varies (`packages/db/__tests__/` vs `apps/agent/src/credentials/`); the implementing engineer picks based on what existing integration tests in the repo do.
- **Voice cache invalidation tests** use the existing `mock.module()` pattern from `apps/agent/src/routes/elevenlabs-credentials.test.ts` — no new test infrastructure.
- **Component test for MaskedKeyInput** uses Vitest if Vitest is configured (check `apps/nextjs/package.json` first); otherwise falls back to a Playwright assertion in `e2e/integrations-elevenlabs.spec.ts` which is already `.skip`'d.

## What's deferred (and why)

| Deferred | Reason |
|---|---|
| Sentry breadcrumb redaction | Defense-in-depth opportunity flagged by the audit but no observed leak. Belongs in a broader telemetry-redaction sweep that touches all loggers. |
| Encryption key version migration | The `encryption_key_id` column defaults to `"v1"` but no rotation mechanism exists. Defer until we actually need to rotate the master key. |
| Schema-divergence comment between `credentials` and `elevenlabs_credentials` | Pure documentation hygiene (P3 doc nit). Fold into `/workflow:write-docs` later. |
| Multi-agent dashboard fan-out | Design exercise for the next spec (`add-elevenlabs-dashboard`). |
| Upgrading `routes/credentials/shared.ts` itself to use the same module pattern | The OAuth pool already works; refactoring it would be unrelated risk. The new `elevenlabs-runtime.ts` follows the same shape as a forward-compatible target. |
