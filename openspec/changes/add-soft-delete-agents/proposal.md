# Proposal: add-soft-delete-agents

## Summary

Add `deletedAt` timestamp column to `agents` table. Convert the one existing hard-delete path (settings.ts:98 remove agent config) to soft-delete. Update agent list queries to filter `WHERE deletedAt IS NULL`. Closes audit finding C11 and preserves referential integrity for historical sessions that reference removed agent IDs.

## Context

Extends `packages/db/src/schema/agents.ts`, `apps/agent/src/routes/settings.ts`, any agent list query sites. Related: archived `2026-04-18-pick-db-writer-boundary` (established the HTTP write boundary where this delete currently flows).

## Motivation

The one user-facing entity delete (remove agent config via dashboard) currently hard-deletes the row. Sessions table references `agents.id` as a foreign key; any historical session that referenced a now-deleted agent loses its join target. Soft-delete preserves historical integrity while satisfying the recurring C11 audit finding at minimum scope. Retention-pruned tables (healthSnapshots, sessionEvents, credentialEvents) stay hard-delete by design — that's a different concern.

## Requirements (ADDED)

- **Soft-delete for agents**: the `agents` table MUST include a nullable `deletedAt` timestamp column. Removal operations MUST set `deletedAt = NOW()` instead of physical delete.
- **Read queries default to live agents**: queries that return "the list of agents" or "active agent by ID" MUST filter `WHERE deletedAt IS NULL` unless explicitly requesting tombstoned records.
- **Historical references preserved**: queries that join `sessions` to `agents` MUST still be able to resolve `agent.id` even when the agent has been soft-deleted, for audit/display of past sessions.

## Scope

**IN:**
- `agents` table only — single delete call site converted (`apps/agent/src/routes/settings.ts:98`)
- List queries updated to filter `WHERE deletedAt IS NULL`
- Tests for both hard + soft path

**OUT:**
- `projects`, `credentials`, `sessions` soft-delete (no justifying delete paths)
- Restore UI (no user requirement yet)
- Hard-delete fallback for GDPR (personal app, not needed)
- Retention-pruned tables (`healthSnapshots`, `sessionEvents`, `credentialEvents`) — stay hard-delete

## Impact

| File | Change |
| ---- | ------ |
| `packages/db/src/schema/agents.ts` | Add `deletedAt: timestamp('deleted_at')` nullable column |
| `packages/db/src/migrations/NNNN_*.sql` | NEW migration adding the column |
| `apps/agent/src/routes/settings.ts:98` | Hard-delete → `update(... set deletedAt = now())` |
| `apps/nextjs/src/lib/get-client.ts:20` | Add `isNull(agents.deletedAt)` to `WHERE` clause |
| `apps/nextjs/src/app/actions/settings.ts:30` | Add `isNull(agentsTable.deletedAt)` to `WHERE` clause |
| `apps/nextjs/src/app/actions/sessions.ts:63` | Add `isNull(agents.deletedAt)` to `WHERE` clause |
| `apps/nextjs/src/app/actions/health.ts:61` | Add `isNull(agents.deletedAt)` to `WHERE` clause |
| `apps/agent/src/routes/agent-self.ts:8` | Query by ID — no filter needed (explicit ID lookup; used for self-registration) |
| `apps/agent/src/routes/projects-discovered.ts:250` | Query by ID — no filter needed (explicit ID lookup) |
| Test files for the above | New unit tests for delete path and list exclusion |

## Risks

- **Missed read query**: any query that forgets the `WHERE deletedAt IS NULL` filter will return soft-deleted agents and appear to "undelete" them from the list. Mitigation: narrow the change to a single soft-delete helper function that all consumers use, OR add a column-level comment + lint to catch raw `.from(agentsTable)` usages.
- **Historical session join drift**: if agents are heavily soft-deleted, the UI may show orphan-ish session references. Mitigation: join already tolerates this because the FK still resolves.
- **Disk creep**: soft-deleted rows never physically disappear. Mitigation: for a personal single-user app, agent turnover is minimal; kilobytes per year at most. If this ever matters, a quarterly cron to hard-prune soft-deleted records older than 90 days is trivial to add later.
