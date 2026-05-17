# Proposal: Collapse notifications/ directory to single file

## Change ID
`collapse-notifications-dir`

## Phase
P1 consolidation (parent: spine-migration · nx-ma6h8 · feature: nx-6e5gg)

## Summary
Move `apps/agent/src/notifications/manager.ts` up to `notifications.ts` and delete the now-empty `channels/` subdirectory.

## Context
- Modifies: `apps/agent/src/notifications/manager.ts` → `apps/agent/src/notifications.ts`
- Deletes: `apps/agent/src/notifications/` (after move)
- Blocks-on: `remove-slack-channel` (P1.4 · nx-mm056), `remove-notification-channels` (P4.7 · nx-bn8we)
- Updates: all imports of `@/notifications/manager` across `apps/agent/src/`

## Motivation
Once Slack (P1.4) and TTS+desktop channels (P4.7) are removed, the manager is the only file left in `notifications/`. A directory with one file is overhead — single file = simpler import paths + less mental indirection.

## Requirements

### Requirement: notifications.ts MUST house all dispatch logic in one file

After the move, `apps/agent/src/notifications.ts` SHALL contain all notification routing logic previously split across `notifications/manager.ts` and `notifications/channels/*`. The `notifications/` directory SHALL NOT exist in the final tree.

#### Scenario: imports resolve cleanly
- **GIVEN** the move is complete
- **WHEN** `pnpm typecheck` runs against `apps/agent/`
- **THEN** zero type errors related to `@/notifications/*` paths
