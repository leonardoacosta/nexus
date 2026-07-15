---
status: draft
---

# Proposal: detach-context-push-from-statusline-lifecycle

## Why

Filed as `nx-ev2x5.3`. `nexus-statusline` renders correctly on every Claude Code statusline
update (visually confirmed live), and its context-window push mechanism
(`context-guard.ts`'s `resolveContext` → `pushContext`, a fire-and-forget `fetch()` PATCH) is
functionally correct in isolation — a manual, direct invocation of the real binary succeeds
end-to-end every time. Yet real, automatic invocations have NEVER once completed this push, for
any session, on this machine — confirmed by `find ~/.claude/scripts/state -iname
'statusline-ctx.*'` showing exactly one such file, created by a manual test, not by any real
render.

Root cause (full evidence in `design.md`): per Claude Code's own documented statusline
behavior, an in-flight statusline execution is cancelled the moment the NEXT one triggers.
`pushContext`'s fetch is unawaited — nothing keeps it alive past `nexus-statusline`'s own
process lifetime, and CC's rapid re-trigger cadence means the next cancellation almost always
wins before the push completes. This is a structural race, not a tuning problem — no timeout
adjustment fixes it, since ANY unawaited background work in a process CC can cancel at any
moment has the same fate.

Net effect: cc-tmux's SES/context-window gauge and `model_letter` segment (fixed for
correlation by `reconcile-session-id-universes`, but still dependent on a live context-store
entry existing at all) render blank for effectively every session, all the time.

## What Changes

- **`apps/agent/src/services/statusline-ctx-poller.ts`** (new): a persistent poller, wired into
  `nx-agent`'s own long-running process (unlike `nexus-statusline`, which is short-lived and
  cancellable), that reads `~/.claude/scripts/state/statusline-ctx.<sessionId>.json` files
  directly — the SAME synchronous, atomic local snapshot `context-guard.ts` already writes
  reliably on every render (`writeJsonAtomic`, not vulnerable to the cancellation race since it
  completes before the process's synchronous work finishes) — and loads their contents straight
  into the existing in-memory session-context store.
- **`apps/agent/src/routes/session-context.ts`**: exposes a new function (e.g.
  `applyStatuslineSnapshot`) that writes an entry into the store, reusing
  `handlePatchSessionContext`'s existing validation/write logic rather than duplicating it — this
  is what the poller calls in-process (no HTTP round-trip needed at all, since the poller lives
  inside the same process as the store).
- **`apps/agent/src/server.ts`**: starts the poller alongside `startProcessWatcher`, same
  lifecycle pattern (start on server init, `stop()` on teardown).
- **`apps/nexus-statusline/src/context-guard.ts`**: removes the now-proven-unreliable
  fire-and-forget `pushContext` HTTP call (0% real-world success rate per live evidence) —
  `resolveContext`'s own local snapshot read/write ("suspicious zero" restore) logic is
  UNCHANGED, only the network-push call site is deleted.
- No change to `handleGetSessionContext`/`handlePatchSessionContext`'s route logic — the PATCH
  route stays callable (harmless), `GET` needs zero changes since it only cares that the store
  has a fresh entry, not how it got there.

## Non-Goals

- No change to `agent-lines.ts`/`usage.ts`'s fetch patterns — confirmed unaffected (both are
  `await`ed by the render's own main path, so they can't race cancellation the way an unawaited
  background push does; see `design.md` § Root Cause).
- No change to `getSessionByCcSessionId`/`updateSessionCcSessionId`/the `reconcile-session-id-
  universes` correlation fix — this is purely about how the context VALUE reaches the store.
- No cross-machine polling — each `nx-agent` instance reads only its own local state dir,
  matching `process-watcher.ts`'s existing per-machine architecture.
- No attempt to make the fire-and-forget push more reliable via retries/shorter timeouts — the
  race is structural, removing it is the fix, not tuning it.

## Context

- Related: `nx-ev2x5.3` (this proposal's own tracking bead) — corrects that bead's own
  originally-filed (and wrong) "not invoked at all" theory with the confirmed root cause.
- Related: `reconcile-session-id-universes` (already shipped) — fixed the correlation layer this
  proposal's fix now actually gets to exercise reliably (a fresh context-store entry existing at
  all was the missing precondition that made correlation's fix hard to observe working for
  sessions other than a manually-poked one).
- Related: `add-session-context-api` (`openspec/changes/archive/2026-07-13-...`) — original spec
  for the context store + PATCH/GET routes this proposal builds on without modifying their
  contract.
- touches: `apps/agent/src/services/statusline-ctx-poller.ts`,
  `apps/agent/src/routes/session-context.ts`, `apps/agent/src/server.ts`,
  `apps/nexus-statusline/src/context-guard.ts`,
  `apps/agent/src/services/statusline-ctx-poller.test.ts`

## Testing

| Seam | Coverage |
| --- | --- |
| Poller's file-parsing logic (pure: raw directory listing + file contents → store entries) | Unit test: well-formed `statusline-ctx.<uuid>.json` files parse into correct entries; a malformed/stale (age > TTL) file is skipped, not applied; empty directory -> no entries — task 3.1 |
| `applyStatuslineSnapshot` write path | Unit test: writes an entry the SAME shape `handlePatchSessionContext` would, confirmed by a subsequent `handleGetSessionContext` call returning the expected `usedPercentage`/`model` — task 3.1 |
| Poller lifecycle (start/stop) | Unit test: `startStatuslineCtxPoller()` returns a handle with a working `stop()` that halts further polling — mirrors `process-watcher.ts`'s own lifecycle test pattern — task 3.2 |
| `context-guard.ts` push removal | Unit test: `resolveContext` no longer attempts any network call (confirm via a `fetch` spy asserting zero invocations) while its local snapshot read/write behavior is unchanged (existing tests for the "suspicious zero" restore path still pass) — task 3.2 |
| End-to-end live verification | With the fix deployed, confirm a NEW `statusline-ctx.<id>.json` file (already happening today) gets picked up automatically by the poller WITHOUT any manual PATCH — `GET /sessions/:id/context` for a real active session returns fresh data within one poll interval, and a fresh `find ~/.claude/scripts/state` check shows the poller is reading real, not manually-created, snapshot files — task 3.3 |
