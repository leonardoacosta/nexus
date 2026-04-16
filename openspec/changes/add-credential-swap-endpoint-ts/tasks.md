# Implementation Tasks

<!-- beads:epic:nx-n8lf -->

## API Batch

- [ ] [1.1] [P-1] Add `ManualSwapResult` type and `manualSwap(targetId: string)` method to `apps/agent/src/credentials/pool.ts` — parks current best-available (status=cooldown, cooldownUntil=now+cooldownMs, rateLimitCount unchanged), emits manual_swap credential_events rows for parked + activated [owner:api-engineer] [beads:nx-rzcm]
- [ ] [1.2] [P-2] Add `handleSwapCredential` handler in `apps/agent/src/routes/credentials.ts` — parses `{ to: string }` body, name→primaryId lookup, calls pool.manualSwap(), emits two audit entries (credential.manual_swap_out + credential.manual_swap_in), returns pool list [owner:api-engineer] [beads:nx-za4q]
- [ ] [1.3] [P-2] Register `POST /credentials/swap` route in `apps/agent/src/routes.ts` after the existing credential routes [owner:api-engineer] [beads:nx-d8wd]

## E2E Batch

- [ ] [2.1] [P-1] Add unit tests to `apps/agent/src/routes/credentials.test.ts` covering: successful swap, 404 name-not-found, 409 target-in-cooldown, 200 no-op (already best-available), audit entries emitted on success [owner:test-writer] [beads:nx-hmr9]
