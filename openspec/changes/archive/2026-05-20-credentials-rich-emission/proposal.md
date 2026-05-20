# Proposal: Credentials reader emits full CcProfile shape

## Change ID

credentials-rich-emission

## Why

`homelab-emits-specs-credentials` (archived 2026-05-20) wired
`credential-pool/reader.ts` to read `~/.claude/.credentials.json` and
emit per-credential rows over `GET /credentials`. The reader produces
the minimal shape `{fingerprint, account, created_at, status}`. The Mac
dashboard's `CcProfile` Codable struct requires `id`, `name`,
`rateLimit429Count: Int`, and `isActive: Bool` — none of which the
reader emits. Decode fails per row, `profiles=[]`, CredentialsView
shows empty despite 18 credentials live on homelab.

## What Changes

Enrich the credential-pool service to emit the full CcProfile shape:

1. **Parse `~/.claude/.credentials.json` payload structure** —
   CC stores credentials with rich metadata: `accountUuid`,
   `email`, `displayName`, `subscriptionType` (free/pro/team/enterprise),
   `rateLimitTier`, `oauthToken.expiresAt`, etc. Read these into the
   reader's per-row projection. Inspect a real file on this Mac
   (`~/.claude/.credentials.json`) before deciding which keys to surface.

2. **Track rate-limit state** — extend the existing 429-counter store
   (verify what cc-credential-manager already maintains) so the reader
   can project `rateLimit429Count` per fingerprint in the trailing
   24h window. Persist in PG via existing `cc_profiles` table if it
   exists; otherwise in-memory cache with a 24h TTL.

3. **Track swap timestamps** — when the agent rotates credentials
   (manual or automatic), record `lastSwapAt` per fingerprint. Surface
   in the row.

4. **Active fingerprint detection** — `isActive: true` for the row
   matching the response's `activeFingerprint` field. False for all
   others. Same selection logic as today's `activeFingerprint`
   computation; this just lifts it into per-row.

5. **Stable id + name** — `id` is the credential file path or a
   deterministic UUID derived from the fingerprint. `name` is the
   account email or display name, falling back to a short
   fingerprint prefix if both absent.

## Context

- depends on: (none — homelab-emits-specs-credentials archived 2026-05-20)
- touches: `apps/agent/src/services/credential-pool/reader.ts`, `apps/agent/src/services/credential-pool/rate-limit-tracker.ts`, `apps/agent/src/services/credential-pool/swap-tracker.ts`, `apps/agent/src/routes/credentials/handlers-crud.ts`, `apps/agent/src/routes/credentials.test.ts`, `packages/core/src/types/credential.ts`, `packages/db/src/schema/ccProfiles.ts`

## Motivation

The Mac dashboard's CredentialsView was designed for rich triage:
which account is active, which are rate-limited, which have an expired
OAuth token. Surfacing only fingerprint+status loses that utility.
Either the reader matches the model OR the model degrades to a list —
matching the model preserves the dashboard's design intent.

The 18 credentials currently sitting on homelab represent real CC
account state Leo's been accumulating. Triage-ready surface > empty
list.

## Locked Decisions

- **Enrich the reader, do not loosen CcProfile** — keeps the model
  expressive on the Swift side; pushes the data-completeness
  responsibility to the producer (where it belongs).
- **PG-backed rate-limit state** if the `cc_profiles` table exists;
  in-memory fallback otherwise. The 429-counter is signal-only, not
  hard durable.
- **Active = matches activeFingerprint** — single source of truth
  in the response envelope.

## Out of Scope

- Credential rotation logic (the agent already owns this in
  cc-credential-manager).
- Multi-machine credential aggregation across multiple agents
  (single-agent today, federation later).
- Editing credentials from Nexus.app. Read-only.
- Credential refresh/swap UI in the Mac dashboard.
