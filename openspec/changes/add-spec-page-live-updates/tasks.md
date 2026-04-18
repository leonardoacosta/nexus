# Implementation Tasks

<!-- beads:epic:nx-u1zy -->

## Agent Batch

- [x] [1.1] [P-1] Add `fs.watch` per project on `openspec/changes/` (shallow) inside spec-watcher [owner:api-engineer] [beads:nx-1lzx]
- [x] [1.2] [P-1] Debounce watch events per spec (300ms) and trigger targeted `openspec show` [owner:api-engineer] [beads:nx-mqim]
- [x] [1.3] [P-2] Handle ENOSPC gracefully — log warning and continue with poll-only mode [owner:api-engineer] [beads:nx-k6yx]
- [x] [1.4] [P-2] Add `GET /specs/events` SSE handler subscribing to lifecycleBus [owner:api-engineer] [beads:nx-zgb2]
- [x] [1.5] [P-2] Coalesce bus events into 5-second windows before flushing to SSE clients [owner:api-engineer] [beads:nx-yagg]

## Types Batch

- [x] [2.1] [P-1] Define `SpecTransitionEvent` discriminated union (new|progress|complete|archived) [owner:types-engineer] [beads:nx-r06f]
- [x] [2.2] [P-1] Define SSE message framing schema shared by agent and client [owner:types-engineer] [beads:nx-pb21]

## API Batch

- [x] [3.1] [P-1] Extract `getAgentBaseUrl()` helper used by both specs and credentials pages [owner:api-engineer] [beads:nx-mlj6]
- [x] [3.2] [P-1] Replace hardcoded `:7402` in specs page with `getAgentBaseUrl()` [owner:api-engineer] [beads:nx-pmtv]

## UI Batch

- [x] [4.1] [P-1] Build `SpecEventsSubscriber` client component wrapping the specs table [owner:ui-engineer] [beads:nx-0lkw]
- [x] [4.2] [P-2] Subscribe to `/specs/events` via EventSource with exponential-backoff reconnect [owner:ui-engineer] [beads:nx-7j30]
- [x] [4.3] [P-2] On reconnect, refetch `/specs/all` to reconcile potentially-missed transitions [owner:ui-engineer] [beads:nx-zm1c]
- [x] [4.4] [P-2] Merge incoming transitions into local state and animate changed rows [owner:ui-engineer] [beads:nx-pib8]
- [x] [4.5] [P-3] Show a small "live" indicator in page header when SSE is connected [owner:ui-engineer] [beads:nx-x670]

## E2E Batch

- [x] [5.1] Test: specs page loads at all (validates port fix) [owner:e2e-engineer] [beads:nx-682r]
- [x] [5.2] Test: ticking a checkbox in tasks.md updates the page within 2 seconds without reload [owner:e2e-engineer] [beads:nx-hcm6]
- [x] [5.3] Test: archiving a spec removes it from the page within 2 seconds without reload [owner:e2e-engineer] [beads:nx-rcu9]
- [x] [5.4] Test: SSE reconnect after simulated network drop catches a missed transition via refetch [owner:e2e-engineer] [beads:nx-v15e]
