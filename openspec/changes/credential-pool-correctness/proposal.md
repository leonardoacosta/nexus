# credential-pool-correctness

## Why

The credential subsystem is dead and racy. `cc-credential-manager` reads
`~/.claude/credentials.json` but Claude Code's auth file is
`~/.claude/.credentials.json` (leading dot), so the Credentials feature never
finds anything. `recoverExpiredCooldowns()` runs OUTSIDE the `lease()`
transaction, opening a rotation race where a recovered credential can be leased
twice. And there is no `credential_swaps` table to record per-session rotation
history, so swap behaviour is unauditable.

## What Changes

- Fix the credential file path to the dotted `.credentials.json`.
- Move `recoverExpiredCooldowns()` inside the `lease()` transaction to remove
  the rotation race.
- Add a `credential_swaps` table plus generated migration for rotation history.
- Verify on the homelab agent that `GET /credentials` returns non-empty with an
  active fingerprint after the dotted-path fix.

## Context

- depends on: `fix-drizzle-snapshot-desync`
- touches: `packages/db/src/schema`, `packages/db/drizzle`, `apps/agent/src/cc-credential-manager.ts`, `apps/agent/src/credentials/pool/pool-core.ts`

## Non-Goals

- Redesigning the credential pool group-assignment or fingerprinting logic.
- Adding a UI surface for the new `credential_swaps` history.
- Cross-repo or multi-account credential federation.
