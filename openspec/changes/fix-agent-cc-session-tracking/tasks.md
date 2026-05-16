# Tasks · fix-agent-cc-session-tracking

<!-- beads:epic:nx-tyq0n -->
<!-- beads:feature:nx-go5gx -->

## DB Batch

- [x] 1.1 One-shot cleanup migration: `UPDATE sessions SET endedAt = NOW(), [beads:nx-esz0i]
  status = 'ended' WHERE endedAt IS NULL AND pid IS NULL AND
  (tmuxTarget IS NULL OR tmuxTarget = '') AND ccSessionId IS NULL AND
  (cwd IS NULL OR cwd = '')`. Document in `packages/db/drizzle/`.

- [x] 1.2 Add index on `(status, endedAt, pid)` to support the process-watcher [beads:nx-u1oqs]
  reconciliation query without scanning all rows.

## API Batch

- [x] 2.1 `apps/agent/src/routes/sessions.ts` — extend `POST /session/start` [beads:nx-gt6yt]
  handler to capture the spawned PID from `tmux list-windows -t <name>
  -F '#{pane_pid}'` after the `tmux new-window`. Persist on the new row.

- [x] 2.2 `apps/agent/src/routes/sessions.ts` — add `withFingerprint` query [beads:nx-ksph6]
  param to `handleGetSessions`. Push the filter into `queryActiveSessions` /
  `queryRecentSessions` so it executes at the DB level, not in Node.

- [x] 2.3 `apps/agent/src/routes/hooks.ts` — replace "insert-on-unknown-session" [beads:nx-9fx3l]
  branch with a `204 No Content` drop. Add the `info`-level orphan log.

- [x] 2.4 New endpoint `POST /sessions/probe` — triggers an immediate [beads:nx-lps43]
  process-watcher reconciliation pass instead of waiting for the next loop tick.

- [x] 2.5 New module `apps/agent/src/services/process-watcher.ts` — 30-second [beads:nx-z2x8r]
  interval `setIntervalAsync` loop that runs `pgrep -af claude`, diffs against
  open session rows, and applies the reconciliation rules (close dead, open new).

- [x] 2.6 Wire `process-watcher` into agent startup (`apps/agent/src/server.ts` [beads:nx-yp4om]
  or wherever heartbeats start). Stop on graceful shutdown.

- [ ] 2.7 Emit `RemoteSessionStarted` / `RemoteSessionEnded` SSE events from [beads:nx-6mxlo]
  the process-watcher reconciliation so connected clients (menu bar, dashboard)
  update in real time.

## UI Batch

- [ ] 3.1 `apps/swift/nexus/nexus/ProcessProbe.swift` — keep in place but flip [beads:nx-v553a]
  to opt-in via a NSUserDefaults flag (`nx.menubar.fallback.processProbe`).
  Default off once this spec lands.

- [ ] 3.2 `apps/swift/nexus/nexus/NexusClient.swift` — switch the default [beads:nx-ir7wz]
  `/sessions` request to `/sessions?withFingerprint=true` so the menu bar
  client doesn't need its own filter pass.

- [ ] 3.3 Dashboard (`apps/nextjs/src/app/session/[id]/page.tsx` consumers) — [beads:nx-f4rp1]
  audit any places that assumed `sessionType: "ad_hoc"` is the default and
  update to handle the new fingerprinted row shape.

## E2E Batch

- [ ] 4.1 Unit test `apps/agent/src/routes/hooks.test.ts` — POST a hook event [beads:nx-6nbds]
  with an unknown sessionId, assert 204 + no DB row created.

- [ ] 4.2 Unit test `apps/agent/src/services/process-watcher.test.ts` — [beads:nx-4c3nk]
  mock `pgrep` output, verify open-row-for-new-pid and close-row-for-dead-pid
  paths.

- [ ] 4.3 Integration test against a real Bun agent + real tmux — spawn a [beads:nx-fa1xy]
  session via `POST /session/start`, assert the row has non-null `pid`,
  `tmuxTarget`, `cwd`. Kill the tmux window; assert reconciliation closes the
  row within 60 seconds.

- [ ] 4.4 [user] Manual smoke: run `claude` on homelab, open the menu bar [beads:nx-s7rpb]
  panel, verify the row appears within 60 s; quit `claude`, verify the row
  disappears within 60 s.

- [ ] 4.5 [user] Backfill verification: after deploying, query the DB for [beads:nx-p71tq]
  `sessions WHERE endedAt IS NULL AND pid IS NULL` — should be zero or near-zero.
