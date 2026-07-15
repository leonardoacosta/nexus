---
status: draft
---

# Proposal: reconcile-session-id-universes

## Why

Filed as `nx-ev2x5.2`. Every real Claude Code session currently creates two unlinked `sessions`
rows — one discovered by `process-watcher.ts` (`id = cc-<pid>-<hash>`, no CC session id), one
created by the socket `session_start` handler fed by Claude Code's own hook (`id` = the real CC
session UUID, `pid = 0`). Neither ever gets `cc_session_id` populated (the bridge column added by
`nx-22xz8`, already shipped and correct) because nothing links the two rows for the same session.

Downstream: `cc-tmux` (a separate repo) queries `GET /sessions/:id/context` using the real CC
session UUID it captures from its own hook. That endpoint's `model` field comes from
`getSessionByCcSessionId`, which finds nothing — no row's `cc_session_id` column ever holds that
value. Row 2's model-letter segment (`F`/`O`/`H`/`S`) renders permanently blank in production.

Full root-cause evidence (live DB query, live journal, exact hook payload, code trace) is in
`design.md` — this re-verifies and corrects a prior investigation (`nx-ev2x5.2`'s own bead notes)
whose "zero UUID rows exist" claim turned out to be a point-in-time sampling artifact, not a
structural truth; the actual gap is narrower and more precisely scoped than originally described.

## What Changes

- **`apps/agent/src/services/socket-server/dispatcher.ts`**: the `session_start` case gains a
  pane-based correlation check BEFORE calling `sessionManager.handleWatcherEvent(watcherEvent)`.
  When the hook's `tmux_target` (raw `%N` pane-id form) can be translated to an existing,
  matching, not-yet-linked `process-watcher` row (`active`/`idle` status), this calls
  `updateSessionCcSessionId` on that row directly and skips creating a second (UUID-keyed) row.
  When no match is found, behavior is unchanged from today (existing fallback, no regression).
- **New pane-translation helper** (pure function: raw `tmux list-panes -a` output → `Map<string
  (%N pane-id), string (session:window.pane)>`) — a small sibling to `process-watcher.ts`'s own
  private `listTmuxPanes`, not a duplicate (different output format, different consumer). Exact
  file placement decided by the DB-batch task (a new small module vs. exporting an addition from
  `process-watcher.ts` — see task 1.1).
- No schema change — `sessions.cc_session_id` already exists (`nx-22xz8`). No change to
  `getSessionByCcSessionId`/`updateSessionCcSessionId` (already correct). No change to
  `process-watcher.ts`'s own row-creation logic, `session-manager.ts`'s `handleWatcherEvent`
  itself, or the external `~/.claude/scripts/hooks/telemetry.sh` hook (a separate repo — this fix
  works entirely from data the hook already sends).

## Non-Goals

- No backfill of historical rows — only new `session_start` events benefit going forward. Old
  unlinked rows age out via the existing stale/reaper logic, untouched.
- No fix to `nx-ev2x5.1` (the separate, already-dead `nexus-emit`/`/hooks` HTTP ingestion path) —
  unrelated transport.
- No change to how `cc-tmux` (installfest repo) queries this endpoint — it already queries
  correctly by the real CC session UUID; this proposal fixes the server side only.
- No attempt to eliminate the RARE remaining fallback case (hook fires before process-watcher has
  discovered the pane) — accepted as a pre-existing, non-regressed edge case.

## Context

- Related: `nx-22xz8` (already shipped) — added `sessions.cc_session_id` + the
  `getSessionByCcSessionId`/`updateSessionCcSessionId` functions this proposal calls but does not
  modify.
- Related: `nx-ev2x5.2` (this proposal's own tracking bead, parent epic `nx-ev2x5`
  cc-telemetry-read) — supersedes that bead's own notes where the live re-investigation
  (`design.md` § Evidence) found a narrower, more precise root cause than originally described.
- Related: `openspec/specs/session-persistence/` — existing capability this proposal adds a
  requirement under (no MODIFIED conflicts — purely additive).
- touches: `apps/agent/src/services/socket-server/dispatcher.ts`,
  `apps/agent/src/services/process-watcher.ts`,
  `apps/agent/src/services/socket-server/dispatcher.test.ts`

## Testing

| Seam | Coverage |
| --- | --- |
| Pane-translation helper (pure: raw `tmux list-panes -a` output string → `%N` -> `session:window.pane` map) | Unit test: well-formed multi-pane output parses correctly; empty/malformed output returns an empty map, never throws — task 3.1 |
| Dispatcher `session_start` correlation — match found | Test: an existing `active` process-watcher row with matching `tmux_target`, no `cc_session_id` yet -> `updateSessionCcSessionId` called with that row's id + the event's `session_id`, `handleWatcherEvent` NOT called (no second row created) — task 3.2 |
| Dispatcher `session_start` correlation — no match (fallback) | Test: no matching row (or `tmux_target` absent from the event) -> `handleWatcherEvent` called exactly as today, unchanged behavior, no error — task 3.2 |
| Idempotency — already-linked row | Test: a matching row that ALREADY carries a `cc_session_id` is excluded from matching (a second `session_start`/heartbeat-shaped event for the same session must not re-match or double-write) — task 3.2 |
| Multiple matches (reused pane) | Test: two matching rows for the same `tmux_target`, differing `last_activity` -> the most-recently-active one is chosen — task 3.2 |
| End-to-end live verification | With a real tracked cc-tmux pane on this machine, confirm `GET /sessions/:id/context` (queried by the real CC session UUID) returns a non-null `model` field after a fresh `session_start` fires — not just source reading — task 3.3 |
