---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-17T20:26:38Z
---

# Proposal: Delete the HTTP /hooks endpoint

## Change ID
`delete-http-hooks-endpoint`

## Phase
P3 ingress-collapse (parent: spine-migration · nx-ma6h8 · feature: nx-pef3t)

## Summary
Remove `routes/hooks.ts` after a confidence cycle running both AF_UNIX and HTTP ingress paths in production.

## Context
- Deletes: `apps/agent/src/routes/hooks.ts`
- Modifies: `apps/agent/src/server.ts` (drop the route registration)
- Depends-on: `migrate-cc-hooks-to-socket` (P3.3 · nx-24yyq) — all CC traffic on socket
- Ordering: this is the LAST P3 task

## Motivation
With socket as sole ingress, the HTTP endpoint is dead code. Removing it eliminates a maintained surface area, simplifies the dispatcher path, and removes the "two doors" mental model.

## Requirements

### Requirement: POST /hooks SHALL return 404

After this change, `POST /hooks` SHALL not be a registered route. The agent's HTTP server returns 404 for that path.

### Requirement: zero traffic on HTTP /hooks for 7 days prior to deletion

A pre-deletion check SHALL confirm zero `routes/hooks.ts` invocations in the last 7 days of logs.

#### Scenario: curl POST /hooks fails post-deletion
- **GIVEN** deletion complete
- **WHEN** `curl -X POST http://localhost:7400/hooks -d '{}'`
- **THEN** returns 404
