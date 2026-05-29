# Session Enrichment — Dashboard Row Signals

## Why

The Mac dashboard's Sessions list shows three labels that carry no information:

- **"active"** — every listed session is active; the badge never varies until a 60-minute idle
  sweep (`apps/agent/src/session-manager.ts`). It tells the user nothing about whether the agent
  can take a command right now.
- **"claude"** — the model name, identical on every row.
- **"pinned"** — not a session property at all; it is the `originAgent` name leaking the literal
  `"pinned"` sentinel that `NexusAggregateClient` emits when a `dashboardEndpoint` is set
  (`apps/swift/NexusShared/Networking/NexusAggregateClient.swift:122`).

The data needed to replace these with meaningful signals already flows through the agent (Claude
Code lifecycle hooks via the dispatcher) and the persistence layer (the `branch` column already
exists end-to-end but is hardcoded `null`). This spec turns three dead labels into live signals.

## What Changes

1. **Agent state (replaces "active"):** derive a 3-state `agentState` — `blocked` / `waiting` /
   `ready` — from the CC hook stream the dispatcher already ingests, and surface it as the row's
   status sigil.
   - `blocked` — last lifecycle hook ∈ {PreToolUse, PostToolUse, UserPromptSubmit, SubagentStart}
     (mid-turn / running a tool).
   - `waiting` — last hook is a `Notification` indicating the agent needs user input (permission
     prompt / idle-await).
   - `ready` — last hook is `Stop` (turn ended, awaiting next prompt).
   - The existing `SessionStatus` (`active|idle|ended|stale|errored`,
     `packages/core/src/types/session.ts:141`) is unchanged — it remains the lifecycle/liveness
     axis. `agentState` is a NEW orthogonal field.

2. **Git branch (replaces "claude"):** populate the already-existing `branch` field by running a
   fail-soft, cwd-memoized `git rev-parse --abbrev-ref HEAD` when the process-watcher
   creates/updates a session (today `apps/agent/src/services/process-watcher.ts:~664` hardcodes
   `branch: null`). The Swift row already prefers branch in its title
   (`SessionRow.swift:53`); the subtitle switches from `project · model` to `project · branch`.

3. **Drop the agent-name badge (removes "pinned"):** stop rendering the trailing `originAgent`
   label on session rows, and stop `NexusAggregateClient` from emitting the `"pinned"` sentinel
   as an agent name. Multi-agent disambiguation, if ever needed, is deferred to grouping —
   out of scope here.

## Context
- touches: `packages/db/src/schema/sessions.ts`, `packages/core/src/types/session.ts`, `apps/agent/src/services/socket-server/dispatcher.ts`, `apps/agent/src/services/process-watcher.ts`, `apps/agent/src/routes/sessions.ts`, `apps/swift/NexusShared/Models/Session.swift`, `apps/swift/nexus/nexus/SessionRow.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`

## Impact

- Affected capability: `session-persistence`.
- Non-breaking: `agentState` is additive (nullable; absence renders as today's behavior).
  The `branch` column already exists. Dropping the agent label is a Swift-render-only change.
- Stack note — Nexus is a Bun-agent + Swift project, so the standard OpenSpec phase batches map
  as: **DB Batch** = `packages/db`, **API Batch** = `apps/agent` (TS), **UI Batch** =
  `apps/swift`, **E2E Batch** = `bun test` + Swift tests.
