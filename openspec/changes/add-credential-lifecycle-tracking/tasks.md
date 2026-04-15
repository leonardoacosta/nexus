# Implementation Tasks

<!-- beads:epic:nx-oz50 -->

## DB Batch

- [x] [1.1] [P-1] Create `credential_events` table schema in `packages/db/src/schema/` with id, credentialId, eventType, sessionId, metadata (jsonb), createdAt + indexes [owner:db-engineer] [beads:nx-nzbp]
- [x] [1.2] [P-1] Export new table from `packages/db/src/index.ts` and run `pnpm db:generate` for migration [owner:db-engineer] [beads:nx-96cd]

## API Batch

- [x] [2.1] [P-1] Add `emitEvent(credentialId, eventType, sessionId?, metadata?)` helper to pool.ts that inserts into credential_events [owner:api-engineer] [beads:nx-96pj]
- [x] [2.2] [P-1] Add credential file watcher using `fs.watch` with 200ms debounce — on create: `pool.add()`, on change: `refreshMetadata()`, on delete: log warning [owner:api-engineer] [beads:nx-z50o]
- [x] [2.3] [P-2] Wire `emitEvent()` calls into existing pool methods: `lease()`, `release()`, `reportRateLimit()`, `add()`, `deleteById()`, `promote()`, `refreshMetadata()` [owner:api-engineer] [beads:nx-ukt0]
- [x] [2.4] [P-2] Start file watcher on agent boot in server.ts after credential pool init [owner:api-engineer] [beads:nx-7wz6]
- [x] [2.5] [P-2] Add session-credential binding: extract `credentialFingerprint` from socket `session_start` events, look up credential, populate `sessions.credentialId` + `credentialFingerprint` [owner:api-engineer] [beads:nx-zhxi]
- [x] [2.6] [P-3] Add retention cleanup for credential_events (delete events > 30 days) alongside existing health_snapshots retention [owner:api-engineer] [beads:nx-lwpo]

## UI Batch

(no UI changes in this spec — dashboard audit trail is a follow-up)

## E2E Batch

- [ ] [4.1] [deferred] Verify file watcher detects new credential file and inserts via pool.add() [owner:e2e-engineer] [beads:nx-urgv]
- [ ] [4.2] [deferred] Verify credential_events table populated after lease/release cycle [owner:e2e-engineer] [beads:nx-b0ew]
