<!-- beads:epic:nx-hnkty -->
<!-- beads:feature:nx-zluk5 -->

# Tasks: credential-pool-correctness

## DB Batch

- [x] [1.1] Add a `credential_swaps` table (schema + generated migration) to track per-session credential rotation history [owner:db-engineer] [type:db] [beads:nx-wce7]

## API Batch

- [ ] [2.1] Fix cc-credential-manager to read `~/.claude/.credentials.json` (leading dot) so the Credentials feature works [owner:api-engineer] [type:api] [beads:nx-t2q5n]
- [ ] [2.2] Move `recoverExpiredCooldowns()` inside the `lease()` transaction to remove the rotation race [owner:api-engineer] [type:api] [beads:nx-jz5f]

## UI Batch

## E2E Batch

- [ ] [3.1] [user] Verify on the homelab agent that `GET /credentials` returns non-empty with an `activeFingerprint` after the dotted-path fix [owner:e2e-engineer] [type:testing] [beads:nx-hdhvk]
