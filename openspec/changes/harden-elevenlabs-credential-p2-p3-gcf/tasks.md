# Implementation Tasks

<!-- beads:epic:nx-z7kl -->
<!-- beads:feature:nx-t3n4o -->

## DB Batch

- [x] [1.1] [P-2] Create FK cascade integration test that inserts agent + elevenlabs_credentials, DELETEs agent, asserts elevenlabs row gone (skips when POSTGRES_URL unset) [owner:db-engineer] [type:testing] [beads:nx-b8qfz]

## API Batch

- [x] [2.1] [P-1] Create `apps/agent/src/credentials/elevenlabs-runtime.ts` with `setElevenlabsRuntime`, `getElevenlabsEncryptionKey`, `getElevenlabsDb`. Single source of runtime state for both routes and tts channel. [owner:api-engineer] [type:api] [beads:nx-d5dmb]
- [x] [2.2] [P-1] Refactor `apps/agent/src/routes/elevenlabs-credentials.ts` to remove `elevenlabsKeyRef` + `initElevenlabsCredentialRoutes` and import `getElevenlabsEncryptionKey` from the new runtime module. Replace hand-rolled type guard in `handlePatchCredentials` with `elevenlabsPatchInput.parse()`. Map upstream fetch throws to `last_test_status_code = NULL` + response `{ok:false, statusCode:null, error:"network"}`. Add tests for `/test` endpoint (mask invariant, decrypt-throw mapping, missing-row 400). [owner:api-engineer] [type:api] [beads:nx-7pirp]
- [x] [2.3] [P-1] Refactor `apps/agent/src/notifications/channels/tts.ts` to remove `ambientDb`/`setTtsDb`/`resetTtsDb` and import `getElevenlabsDb` + `getElevenlabsEncryptionKey` from the runtime module. Add `scrubFetchError(err)` helper that strips `xi-api-key` (case-insensitive) at any depth from logged error objects. Emit `lifecycleBus.emit("CredentialDecryptFallback", { agentId, source: "tts" })` before falling back to env on decrypt failure. [owner:api-engineer] [type:api] [beads:nx-xgwl2]
- [x] [2.4] [P-1] Add `lifecycleBus` event variant `CredentialDecryptFallback` in `apps/agent/src/services/lifecycle-bus.ts` (additive — extend `LifecycleEventMap`). [owner:api-engineer] [type:api] [beads:nx-aorhe]
- [x] [2.5] [P-2] Update `apps/agent/src/notifications/manager.ts` to remove the `setTtsDb(db)` call (state now flows through the runtime module set by `startServer`). [owner:api-engineer] [type:api] [beads:nx-b4bkw]
- [x] [2.6] [P-1] Create `apps/agent/src/server-routes-elevenlabs.ts` exporting `tryHandleElevenlabsRoute(request, url, db)` that handles all 5 elevenlabs routes. Mirror the shape of `server-routes-credentials.ts`. [owner:api-engineer] [type:api] [beads:nx-1i05t]
- [x] [2.7] [P-2] Replace the inlined elevenlabs branch (~100 LOC, lines 250-349) in `apps/agent/src/server-request-handler.ts` with a single `tryHandleElevenlabsRoute(...)` call positioned identically. Update `apps/agent/src/server.ts` to call `setElevenlabsRuntime({ encryptionKey, db })` once during init in place of `initElevenlabsCredentialRoutes`. [owner:api-engineer] [type:api] [beads:nx-7vhx4]
- [x] [2.8] [P-2] Delete `apps/agent/src/routes/elevenlabs-builder.ts` (orphan — verified zero callers via grep). [owner:api-engineer] [type:api] [beads:nx-k2g6t]
- [x] [2.9] [P-2] Add `invalidateVoiceCache(agentId)` export to `apps/agent/src/routes/elevenlabs-voices.ts`. Cap the in-memory cache at 32 entries with LRU eviction (use a `Map` with insertion-order delete-and-reinsert pattern, or a small LRU helper). Wire `handlePatchCredentials` to call it when `apiKey` is in the patched fields, and `handleDeleteCredentials` to call it unconditionally. Add unit tests covering invalidation on PATCH-with-apiKey, on DELETE, and the LRU cap behavior. [owner:api-engineer] [type:api] [beads:nx-jtpek]
- [x] [2.10] [P-2] Update `packages/core/src/types/elevenlabs.ts` so `elevenlabsTestResponse` accepts `statusCode: number | null` (was `number`). Bump any inferred type sites accordingly. [owner:types-engineer] [type:api] [beads:nx-il6hc]

## UI Batch

- [ ] [3.1] [P-1] Update `apps/nextjs/src/app/actions/elevenlabs-credentials.ts` `saveCredentials` to whitelist known agent error strings (`"encryption key not configured"`, `"invalid input"`, `"no credential stored"`, `"could not decrypt stored credential"`) and map them to user-facing messages. Generic fallback `"Could not save credentials. Check the agent log."` for unknown errors. Log the raw agent text server-side via `console.error` (not echoed to thrown Error message). [owner:ui-engineer] [type:ui] [beads:nx-s4gqt]
- [ ] [3.2] [P-2] Update `apps/nextjs/src/components/TestConnectionPanel.tsx` to render `statusCode === null` as `"Network error — could not reach api.elevenlabs.io"` instead of `"Status: 0"`. [owner:ui-engineer] [type:ui] [beads:nx-tmkbr]
- [ ] [3.3] [P-2] Add `apps/nextjs/src/components/MaskedKeyInput.test.tsx` (or a Vitest test wherever component tests live in this repo — inspect first) asserting that `inputElement.value === ""` on first render with `hasKey={true}` and that the bullet string never appears in the `value` attribute. [owner:ui-engineer] [type:testing] [beads:nx-7xdi8]

## E2E Batch

- [ ] [4.1] [P-2] Extend the existing Playwright spec at `apps/nextjs/e2e/integrations-elevenlabs.spec.ts` (currently `.skip`'d) to assert: (a) input.value !== bullet placeholder on first render, (b) network-error result renders the friendly label not "Status: 0", (c) submitting an empty apiKey produces the new "invalid input" message rather than silently storing an empty value. Keep the file `.skip`'d if Playwright is still not wired; the test bodies remain valuable as documentation. [owner:e2e-engineer] [type:testing] [beads:nx-b3g5k]
