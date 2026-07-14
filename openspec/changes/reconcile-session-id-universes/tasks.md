<!-- beads:epic:nx-f8ahu -->
<!-- beads:feature:nx-scqfa -->

# Tasks: reconcile-session-id-universes

> Literal `## DB/API/E2E Batch` headers per `/feature`'s wave-plan-build contract (no UI batch —
> this is a backend-only fix, no user-facing surface changes). DB = the pure pane-translation
> helper (no schema change — `sessions.cc_session_id` already exists per `nx-22xz8`); API =
> dispatcher.ts correlation wiring; E2E = tests + live verification. Full design rationale (why
> merge-not-link, the exact evidence resolving the bead's original misdiagnosis) in `design.md` —
> do not re-derive here.

## DB Batch

- [x] [1.1] Add a small, pure pane-translation helper: given raw `tmux list-panes -a -F [beads:nx-i0uz0]
  '#{pane_id}|#{session_name}:#{window_index}.#{pane_index}'` output (a newline-separated string
  of `%N|session:window.pane` pairs), return a `Map<string, string>` from the raw `%N` pane-id to
  the `session:window.pane` address. Malformed/empty lines are skipped (never throws); no tmux
  server reachable -> caller gets an empty map (the actual `tmux` shell-out lives in a separate,
  thin wrapper function — keep the PARSING logic itself pure and synchronously testable without a
  live tmux process, mirroring `process-watcher.ts`'s own `listTmuxPanes`/`RawPane` pattern:
  read that function first for the exact style to match). Place this in a new file
  `apps/agent/src/services/socket-server/pane-translation.ts` (small, single-purpose, imported
  only by the dispatcher — do NOT add it to `process-watcher.ts` itself, its own `listTmuxPanes`
  uses a different field format for a different consumer and is unexported/private by design).
  [owner:general-purpose] [type:api]

## API Batch

- [x] [2.1] In `apps/agent/src/services/socket-server/dispatcher.ts`'s `session_start` case [beads:nx-i6t66]
  (currently: constructs `watcherEvent`, calls `sessionManager.handleWatcherEvent(watcherEvent)`
  unconditionally, then does best-effort credential binding), insert a correlation check BEFORE
  the `handleWatcherEvent` call: if `event.tmux_target` is present, call the new pane-translation
  helper (task 1.1) to get the `%N -> session:window.pane` map, look up `event.tmux_target` in it
  to get the translated address, then query `sessions` (via the existing `db` — this file already
  has `db` in scope from `SocketDispatchDeps`) for a row where `tmux_target` equals the translated
  address AND `status IN ('active', 'idle')` AND (`cc_session_id` IS NULL OR `cc_session_id` = '')
  — excluding already-linked rows (idempotency: a repeat `session_start`/heartbeat-shaped event
  for an already-correlated session must not re-match). If MULTIPLE rows match, pick the one with
  the most recent `last_activity`. [owner:general-purpose] [type:api]
- [x] [2.2] Branch on task 2.1's lookup result: **match found** -> call [beads:nx-5naya]
  `updateSessionCcSessionId(db, matchedRow.id, event.session_id)` (import from `../../db/sessions`,
  already exists, do not modify it) and do NOT call `sessionManager.handleWatcherEvent(...)` for
  this event (skip creating the second, UUID-keyed row entirely) — the rest of the existing
  `session_start` case (credential binding, `processHookEvent` spine call) still runs unchanged,
  since those operate on their own inputs, not on the row `handleWatcherEvent` would have created.
  **No match found** (tmux_target absent from the event, translation lookup misses, or no
  matching DB row) -> fall back to TODAY'S UNCHANGED BEHAVIOR: call
  `sessionManager.handleWatcherEvent(watcherEvent)` exactly as the code does now. This is a strict
  regression guard — the new path can only ADD correlation, never regress an unmatched session
  below its current (accepted, unlinked) behavior. Log which branch was taken at `debug` level
  (mirroring this file's existing logging conventions) so the two paths are distinguishable in
  production logs during rollout. [owner:general-purpose] [type:api]

## E2E Batch

- [ ] [3.1] Add a test file `apps/agent/src/services/socket-server/pane-translation.test.ts` [beads:nx-kykis]
  (`bun test`, matching this package's existing test conventions — check
  `dispatcher.test.ts`/`process-watcher.test.ts` for the exact style/mocking patterns used in
  this repo before writing new tests) covering the pure parsing function from task 1.1:
  well-formed multi-line `%N|session:window.pane` output parses into the correct map; a line
  missing a `|` separator or otherwise malformed is skipped, not thrown on; empty input string ->
  empty map. [owner:general-purpose] [type:testing]
- [ ] [3.2] Extend `apps/agent/src/services/socket-server/dispatcher.test.ts` with cases for the [beads:nx-ca73u]
  new `session_start` correlation branch (task 2.1/2.2), mocking the DB/tmux calls per this
  file's existing test conventions (check how existing `session_start` tests in this file mock
  `db`/`sessionManager`before writing new ones):
  - Match found (existing `active` row, matching translated `tmux_target`, no `cc_session_id`
    yet) -> asserts `updateSessionCcSessionId` was called with the matched row's id + the event's
    `session_id`, and `sessionManager.handleWatcherEvent` was NOT called.
  - No match (no row shares the translated `tmux_target`, or the event has no `tmux_target` at
    all) -> asserts `sessionManager.handleWatcherEvent` WAS called (today's unchanged path), and
    `updateSessionCcSessionId` was NOT called.
  - Already-linked row (a matching row already has a non-empty `cc_session_id`) -> excluded from
    matching; falls through to the no-match/fallback path, not re-matched or double-written.
  - Multiple matching rows sharing the same translated `tmux_target` (a reused pane, stale
    unclosed sibling row) -> the one with the most recent `last_activity` is chosen.
  Run `bun test` (or this package's documented test invocation — confirm via `package.json`
  `scripts.test`) for the affected files and paste the full passing output (0 failures).
  [owner:general-purpose] [type:testing]
- [ ] [3.3] Live verification (not source-reading): with the fix deployed on this machine (check [beads:nx-u690f]
  this repo's own dev/deploy loop — `deploy/` directory scripts, or however nexus-agent gets
  restarted with local changes picked up for a live check), trigger a FRESH `session_start` for a
  real, currently-tracked `cc-tmux` pane on this machine (e.g. open a new Claude Code session in
  a tmux pane that already has a `@cc-project`/`@cc-session-id` pane option, or use an existing
  one that hasn't yet correlated), then query `GET /sessions/:id/context` using that pane's real
  CC session UUID (`tmux show-options -p -t <pane> @cc-session-id` in the installfest repo gives
  you the exact value cc-tmux itself uses) and confirm the response's `model` field is non-null —
  this is the actual, originally-filed acceptance criterion for `nx-ev2x5.2`. Also directly query
  the live `sessions` table (same read-only method used during this spec's own investigation) to
  confirm the matched process-watcher row now carries the correct `cc_session_id`, and that NO
  new UUID-keyed row was created for this same session (confirming the "merge, don't duplicate"
  behavior actually holds live, not just in unit tests). Paste both the HTTP response and the DB
  query output. [owner:general-purpose] [type:testing]
