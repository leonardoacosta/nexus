# Proposal: Add POST /credentials/swap Endpoint (TypeScript)

## Change ID
`add-credential-swap-endpoint-ts`

## Summary
Add `POST /credentials/swap` to the agent HTTP server, letting external callers (tmux menus, CLI scripts) request a credential switch to a specific named account without waiting for a rate-limit event.

## Context
- Extends: `apps/agent/src/credentials/pool.ts` — adds `manualSwap(targetId)` method
- Extends: `apps/agent/src/routes/credentials.ts` — adds `handleSwapCredential` handler
- Extends: `apps/agent/src/routes.ts` — registers the new route
- Related: `openspec/specs/credential-http-endpoint/spec.md` — owns route auth and audit requirements
- Related: `openspec/specs/credential-pool/spec.md` — owns pool lifecycle semantics
- Supersedes: `openspec/changes/add-credential-swap-endpoint/` (stale Rust spec, incorrect file paths and non-existent functions)

## Motivation
The credential pool auto-selects the best available account via `lease()`, ordered by `rateLimitCount` and `leasedAt`. There is no mechanism for an external caller to force a switch to a specific named account (`"personal"`, `"work"`) without triggering a false rate-limit event. The existing `POST /credentials/:id/promote` is for promoting within a duplicate-fingerprint group, not between distinct accounts. Adding `POST /credentials/swap` closes this gap by:

1. Looking up the target credential by its `name` field
2. Putting the current best-available credential on a **manual cooldown** (without incrementing `rateLimitCount`) so the pool does not treat it as rate-limited
3. Returning the updated pool status

## Requirements

### Requirement: POST /credentials/swap endpoint
The agent HTTP server SHALL expose `POST /credentials/swap` accepting `{ "to": "<name>" }` in the request body. The handler SHALL:
- Look up the primary credential whose `name` field matches the request body `to` value
- Return 404 if no credential with that name exists
- Return 409 if the target credential's status is `"cooldown"`
- Return 200 (no-op) if the target is already the best-available credential (lowest rateLimitCount, status available, isPrimary)
- Otherwise: call `pool.manualSwap(targetId)`, which puts the current best-available on a timed cooldown without incrementing `rateLimitCount`, and return the updated pool list

### Requirement: manualSwap pool method
`CredentialPool` SHALL expose `manualSwap(targetId: string): Promise<ManualSwapResult | null>` where `ManualSwapResult = { parked: CredentialRow | null; activated: CredentialRow }`. The method SHALL:
- Return `null` if `targetId` does not exist in the pool
- If the target is already the best-available (or only available credential), return `{ parked: null, activated: target }`
- Otherwise: find the current best-available primary credential (lowest `rateLimitCount`, available, isPrimary, excluding target), set its status to `"cooldown"` with `cooldownUntil = now + cooldownMs` but WITHOUT incrementing `rateLimitCount`, and return `{ parked: parkedRow, activated: targetRow }`
- Emit a `credential_events` row with `eventType = "manual_swap"` for both the parked and activated credentials

### Requirement: Auth and audit parity
`POST /credentials/swap` SHALL require a valid `X-Nexus-Secret` header (enforced by existing global auth middleware). The handler SHALL emit two structured audit log entries on success — one with `event: "credential.manual_swap_out"` for the parked credential and one with `event: "credential.manual_swap_in"` for the activated credential — using the existing `emitAudit()` helper.

## Scope
- **IN**: `manualSwap()` pool method, `handleSwapCredential` HTTP handler, route registration, unit tests for handler and pool method
- **OUT**: Changes to existing `promote()` or `reportRateLimit()` internals, UI changes, debounce window changes, new DB columns or tables

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/credentials/pool.ts` | Add `manualSwap(targetId)` method + `ManualSwapResult` type |
| `apps/agent/src/routes/credentials.ts` | Add `handleSwapCredential` handler |
| `apps/agent/src/routes.ts` | Register `POST /credentials/swap` |
| `apps/agent/src/routes/credentials.test.ts` | Add tests for swap handler |

## Risks
| Risk | Mitigation |
|------|-----------|
| Manual swap parks a credential that external leases still hold | `manualSwap` sets cooldown without decrementing `rateLimitCount`, so the credential recovers naturally when cooldown expires; active leases are not revoked |
| Name lookup is ambiguous when multiple credentials share the same name | Query selects the primary credential with that name; if there is still ambiguity (data bug), return 409 with message listing the matching IDs |
| Rapid repeated swap calls could churn the pool | The parked credential enters the same cooldown window as a rate-limit event (default 5 min), preventing rapid re-swap of the same pair |
