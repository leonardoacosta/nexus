# Proposal: Add Credential Lifecycle Tracking

## Change ID
`add-credential-lifecycle-tracking`

## Summary
Add a file watcher for auto-importing credential changes, bind sessions to active credentials via socket events, and persist credential lifecycle events to a dedicated audit table.

## Context
- Extends: `apps/agent/src/credentials/pool.ts`, `apps/agent/src/server.ts`, `packages/db/src/schema/`
- Extends: `apps/agent/src/services/socket-server.ts`, `apps/agent/src/db/sessions.ts`
- Related: `credential-pool` spec (lease/release lifecycle), `session-persistence` spec (session tracking), `credential-analytics` spec (usage aggregation)

## Why
The credential pool has a fully built lease/release/cooldown state machine, but nothing drives it in production. Three gaps block credential visibility:

1. **No file watcher**: Credential files are only read at import or agent restart. When CC refreshes tokens or the user adds new credentials, the agent doesn't notice until restarted.
2. **Session binding missing**: `sessions.credentialId` exists in the schema but is always NULL. Can't tell which of 18 credentials a CC session is using.
3. **No audit trail**: The pool emits 9+ event types to the logger but none are persisted. Can't answer "when did this credential get rate-limited?" or "which account was active at timestamp T?"

## Requirements

### Requirement: Credential file watcher
The agent MUST watch `~/.config/nexus/credentials/` for file changes. New `acct-*.json` files trigger `pool.add()`. Changed files trigger metadata refresh. Deletions are logged but do not remove DB rows.

### Requirement: Session-credential binding via socket event
When a CC hook sends a `session_start` event containing a `credentialFingerprint` field, the agent MUST populate `sessions.credentialId` and `sessions.credentialFingerprint` for that session.

### Requirement: Credential lifecycle event table
A new `credential_events` table MUST persist lifecycle events (leased, released, cooldown, rate-limited, promoted, deleted) with credential_id, session_id, event_type, metadata, and timestamp. Pool methods MUST insert rows alongside existing logger calls.

## Scope
- **IN**: File watcher with auto-import, session-credential binding via socket, credential_events table + pool-level inserts
- **OUT**: API interception/proxy layer, credential rotation automation, dashboard UI for audit trail, CC hook modifications (assumes fingerprint is available in session_start)

## What Changes
| Area | Change |
|------|--------|
| `packages/db/src/schema/` | Add `credentialEvents` table |
| `apps/agent/src/credentials/pool.ts` | Add file watcher startup, emit audit events to DB |
| `apps/agent/src/server.ts` | Start file watcher on boot |
| `apps/agent/src/services/socket-server.ts` | Extract `credentialFingerprint` from session_start events |
| `apps/agent/src/db/sessions.ts` | Populate `credentialId`/`credentialFingerprint` when binding info available |

## Risks
| Risk | Mitigation |
|------|-----------|
| File watcher `fs.watch` instability on Linux (known inotify quirks) | Use debounced handler (100ms) + verify file is valid JSON before processing |
| CC hooks may not send credentialFingerprint yet | Session binding is best-effort — NULL credentialId is still valid. Document hook change needed. |
| Audit table grows unbounded | Add retention policy (same pattern as health_snapshots — prune events older than 30 days) |
