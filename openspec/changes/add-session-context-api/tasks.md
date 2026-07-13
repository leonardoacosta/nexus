<!-- beads:epic:nx-oxbf8 -->
<!-- beads:feature:nx-9am69 -->

# Implementation Tasks

## API Batch

- [x] [2.1] [P-1] Add `packages/core/src/types/session-context.ts` — shared Zod schemas for the PATCH body and GET response (see proposal.md § Requirements for exact field shapes). Export from `packages/core/src/index.ts`, mirroring `types/integrations.ts`'s conventions. [owner:types-engineer] [type:api] [beads:nx-sh5rm]
- [x] [2.2] [P-2] Add `apps/agent/src/routes/session-context.ts` — in-memory TTL-cached session-context store + GET/PATCH handlers + dispatcher (see design.md § Data flow and proposal.md § Requirements for the exact store shape, TTL, and route contract; mirror `elevenlabs-voices.ts`'s cache pattern and `integration-credentials.ts`'s path-parsing/dispatcher shape). [owner:api-engineer] [type:api] [beads:nx-ggsys]
- [x] [2.3] [P-3] Register the new routes in `apps/agent/src/server-request-handler.ts` (same delegation pattern as `tryHandleElevenlabsRoute`/`tryHandleIntegrationCredentialsRoute` — add the entry to `LEGACY_DISPATCH_ROUTES` and the dispatch-body delegation call). [owner:api-engineer] [type:api] [beads:nx-vti4u]

## UI Batch

- [ ] [3.1] [P-1] Add the fire-and-forget push in `apps/nexus-statusline/src/context-guard.ts` after `resolveContext()` resolves a value (guard logic itself unchanged) — see proposal.md § Requirements and design.md § Push mechanism / § Local agent URL resolution for the exact contract (non-blocking, timeout, URL fallback, error-swallowing). [owner:api-engineer] [type:api] [beads:nx-n7tc1]
- [ ] [3.2] [P-2] Remove `session-context.ts`'s `writeSessionContext()` export + call site — see proposal.md § Requirements ("SHALL NOT write the tmux-pane-keyed session-context file") for exactly what must and must not change, including keeping `gcSessionContext`/`GC_STATE_PREFIXES` intact for orphan cleanup. [owner:api-engineer] [type:api] [beads:nx-550kj]

## E2E Batch

- [ ] [4.1] Unit tests for the session-context store + routes — fresh-entry read, stale-entry-treated-as-absent (TTL), 204 on valid write, 400 on invalid `usedPercentage`/`contextWindowSize`, 404 on unknown/stale session id. [owner:tdd-integration] [type:testing] [beads:nx-h6y76]
- [ ] [4.2] Unit tests for `context-guard.ts`'s push behavior (non-blocking, carries resolved not raw value, existing guard coverage stays green) and `session-context.ts`'s removal (no pane file written; GC still sweeps a pre-seeded orphan fixture) — see proposal.md § Testing for the seam-to-task mapping. [owner:tdd-integration] [type:testing] [beads:nx-5s0vf]
