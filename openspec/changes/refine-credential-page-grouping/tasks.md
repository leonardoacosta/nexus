# Implementation Tasks

<!-- beads:epic:nx-fjm9 -->

## Agent Batch

- [ ] [1.1] [P-1] Add fs watcher for `~/.claude/.credentials.json` with realpath resolution and 200ms debounce [owner:api-engineer] [beads:nx-46hm]
- [ ] [1.2] [P-1] Compute active fingerprint by parsing watched file and matching against pool rows [owner:api-engineer] [beads:nx-kuid]
- [ ] [1.3] [P-2] Add `GET /credentials/active` endpoint returning `{ fingerprint, resolvedPath, observedAt }` [owner:api-engineer] [beads:nx-j1ik]
- [ ] [1.4] [P-2] Include `activeFingerprint` in `GET /credentials` response payload [owner:api-engineer] [beads:nx-w0zl]

## Types Batch

- [ ] [2.1] [P-1] Define `Account`, `CredentialFile`, `UsageSnapshot` types in shared types package [owner:types-engineer] [beads:nx-7qzi]
- [ ] [2.2] [P-1] Define Zod schema for `/credentials/active` response [owner:types-engineer] [beads:nx-t0d0]

## API Batch

- [ ] [3.1] [P-1] Reshape `fetchCredentials()` server action to account-first structure with nested snapshots [owner:api-engineer] [beads:nx-ioku]
- [ ] [3.2] [P-2] Merge active fingerprint into account rows before returning [owner:api-engineer] [beads:nx-ervr]
- [ ] [3.3] [P-2] Expand usage fetch scope from first-10 to all visible accounts with per-account error isolation [owner:api-engineer] [beads:nx-kv04]

## UI Batch

- [ ] [4.1] [P-1] Build `AccountRow` component with expand/collapse for snapshots [owner:ui-engineer] [beads:nx-phdc]
- [ ] [4.2] [P-1] Build `UsageCell` showing percent + resets-at with unpolled fallback [owner:ui-engineer] [beads:nx-nbq3]
- [ ] [4.3] [P-1] Build `ActiveBadge` component with tooltip showing resolved path [owner:ui-engineer] [beads:nx-9ccy]
- [ ] [4.4] [P-2] Replace flat table with account-first grouped table in credentials page [owner:ui-engineer] [beads:nx-db5l]
- [ ] [4.5] [P-2] Update page header count to reflect account cardinality, not file cardinality [owner:ui-engineer] [beads:nx-nc65]
- [ ] [4.6] [P-3] Preserve column sort on account rows; add nested sort for snapshot rows [owner:ui-engineer] [beads:nx-3n7l]

## E2E Batch

- [ ] [5.1] Test: page renders N account rows for N fingerprints, expanding shows snapshot files [owner:e2e-engineer] [beads:nx-j2x4]
- [ ] [5.2] Test: swapping `~/.claude/.credentials.json` target updates active badge within 3s [owner:e2e-engineer] [beads:nx-7ty2]
- [ ] [5.3] Test: usage cell renders percent when polled, fallback when not polled [owner:e2e-engineer] [beads:nx-uc44]
