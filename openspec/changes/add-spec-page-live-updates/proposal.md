# Proposal: Add Spec Page Live Updates

## Change ID
`add-spec-page-live-updates`

## Summary
Make the specs page auto-update as openspec proposals and tasks are written on disk: fix the frontend port mismatch, add a filesystem watcher inside the spec-watcher service to invalidate cache on write, and stream transitions to the browser via Server-Sent Events.

## Motivation
The specs page currently hits port 7402 while the agent listens on 7400, so the page fails to load at all in its default deployment. Even once the port is corrected, the only mechanism for keeping the page fresh is the 60-second `openspec list --json` poll plus a manual browser reload. When a user ticks a checkbox in `tasks.md` or archives a change, the page lags by up to 60 seconds and will not refresh until the tab is re-loaded. The user's mental model is "the page reflects what's on disk right now" — achieving that requires both a filesystem watch for low-latency detection and a push channel to the browser.

## Context
- Extends: `apps/agent/src/services/spec-watcher.ts` (polling service + lifecycleBus)
- Extends: `apps/agent/src/routes/specs.ts`, `apps/agent/src/routes/specs-builder.ts`
- Extends: `apps/nextjs/src/app/specs/page.tsx` (current port 7402 hardcode)
- Related: `spec-watcher` spec (existing polling behaviour), archived `add-spec-watcher` change

## Requirements

### Requirement: Filesystem watcher invalidates cache on openspec writes
The spec-watcher service MUST watch each registered project's `openspec/changes/` directory (shallow) and trigger a targeted re-poll of the affected change within 1 second of any write event.

### Requirement: Server-Sent Events stream for spec transitions
The agent MUST expose `GET /specs/events` as an SSE stream that emits `SpecTransition` events whenever the spec-watcher publishes to `lifecycleBus` (new spec, progress, all-complete, archived).

### Requirement: Specs page subscribes to the SSE stream
The specs page MUST subscribe to `/specs/events` on mount, merge incoming transitions into the cached data, and re-render affected rows without a manual reload.

### Requirement: Specs page agent port is resolved from config
The specs page MUST read the agent host and port from the same configuration source as the credentials page (not a hardcoded literal), eliminating the 7402/7400 mismatch.

## Scope
- **IN**: fs.watch hook inside spec-watcher, SSE endpoint, SSE client on specs page, port resolution fix, debounced event coalescing
- **OUT**: replacing the 60-second poll (kept as a safety net), WebSocket or long-poll alternatives to SSE, multi-agent event aggregation, authentication for the SSE stream, TUI client consumption of SSE

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/services/spec-watcher.ts` | Add `fs.watch` per project on `openspec/changes/`, debounce 300ms, trigger targeted `openspec show` and diff |
| `apps/agent/src/routes/specs.ts` | Add `GET /specs/events` SSE handler subscribing to `lifecycleBus` |
| `apps/nextjs/src/app/specs/page.tsx` | Replace port `7402` literal with resolved config; add client boundary subscribing to SSE |
| `apps/nextjs/src/app/specs/` | New client component `SpecEventsSubscriber` wrapping page table |

## Risks
| Risk | Mitigation |
|------|-----------|
| inotify watch limits on Linux when many projects are registered | Watch only the shallow `openspec/changes/` dir (not recursive subtree); log and degrade to poll-only if ENOSPC observed |
| SSE connection drop silently leaves page stale | Client reconnects with exponential backoff and refetches `/specs/all` on reconnect to catch missed transitions |
| Burst of writes (e.g., `bd sync`) spams transitions | Debounce per-spec in the watcher (300ms) and coalesce on the bus (5s window, matching existing TTS behaviour) |
| Port resolution refactor could break credentials page by accident | Extract a single `getAgentBaseUrl()` helper used by both pages |
