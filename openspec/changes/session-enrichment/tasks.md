<!-- beads:epic:nx-f8ahu -->
<!-- beads:feature:nx-ace8j -->

# Tasks — Session Enrichment

## DB Batch
- [x] Add `agentState` column to `packages/db/src/schema/sessions.ts` (text, nullable; allowed values `blocked|waiting|ready`), then regenerate + apply the migration via drizzle-kit (`pnpm --filter @nexus/db db:push`) [beads:nx-ojqb9]
- [x] Verify the existing `branch` column is selected in session reads (`sessionToRow` / session select in `apps/agent/src/db/sessions.ts`) [beads:nx-lak3e]

## API Batch
- [x] Add `agentState` to the session domain type in `packages/core/src/types/session.ts` (union `"blocked" | "waiting" | "ready"`, nullable) [beads:nx-ug4x2]
- [x] In `apps/agent/src/services/socket-server/dispatcher.ts`, map ingested hooks to `agentState` and persist per session: PreToolUse/PostToolUse/UserPromptSubmit/SubagentStart → `blocked`; Notification-awaiting-input → `waiting`; Stop → `ready` [beads:nx-rwsju]
- [x] In `apps/agent/src/services/process-watcher.ts` (~line 664), replace the hardcoded `branch: null` with a fail-soft, cwd-memoized `git rev-parse --abbrev-ref HEAD` (reuse the existing project-resolver memoization pattern) [beads:nx-k9ujb]
- [x] In `apps/agent/src/routes/sessions.ts`, include `agentState` in the session payload returned to clients [beads:nx-hhudi]
- [x] Unit tests: hook→agentState mapping for all four transitions; branch resolution for git cwd, non-git cwd, and lookup failure (fail-soft null) [beads:nx-131wz]

## UI Batch
- [x] In `apps/swift/NexusShared/Models/Session.swift`, decode `agentState` (safe default when absent) [beads:nx-036vw]
- [x] In `apps/swift/nexus/nexus/SessionRow.swift`, drive the status sigil off `agentState` (3-state: blocked / waiting / ready), switch the subtitle from model to `branch`, and remove the trailing originAgent label [beads:nx-c9muh]
- [x] In `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, stop emitting the `"pinned"` sentinel as the agent name [beads:nx-70ep8]

## E2E Batch
- [ ] Agent integration test (`bun test`): drive a hook sequence through socket → dispatcher and assert the persisted `agentState` transitions (blocked → waiting → ready), plus branch capture on a real git working directory [beads:nx-8s85n]
- [ ] Swift test: `SessionRow` renders the correct sigil per `agentState`, shows `branch` in the subtitle, and omits the agent-name label [beads:nx-mld93]
