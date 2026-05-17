## MODIFIED Requirements

### Requirement: notification dispatch SHALL live in a single file

The agent's notification dispatcher SHALL be implemented in `apps/agent/src/notifications.ts` as a single module. The `apps/agent/src/notifications/` directory SHALL NOT exist after this change. All notification routing logic previously split across `notifications/manager.ts` and `notifications/channels/*` is consolidated into the single file.

#### Scenario: imports resolve from the flat path
- **GIVEN** a caller imports notification dispatch
- **WHEN** the import path is `@/notifications` (resolving to `notifications.ts`)
- **THEN** typecheck succeeds and dispatch behavior is unchanged

#### Scenario: directory is gone
- **GIVEN** the consolidation is complete
- **WHEN** `ls apps/agent/src/notifications/`
- **THEN** the directory does not exist (ENOENT)
