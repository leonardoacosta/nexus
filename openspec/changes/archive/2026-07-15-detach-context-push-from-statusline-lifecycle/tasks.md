<!-- beads:epic:nx-f8ahu -->
<!-- beads:feature:nx-y24r3 -->

# Tasks: detach-context-push-from-statusline-lifecycle

> Literal `## DB/API/E2E Batch` headers per `/feature`'s wave-plan-build contract (no UI batch —
> backend-only fix). DB = the store-writer export + pure poller-parsing logic; API = the poller
> service itself, its server.ts wiring, and the context-guard.ts push removal; E2E = tests + live
> verification. Full root-cause evidence and design rationale in `design.md` — do not re-derive
> here.

## DB Batch

- [x] [1.1] `apps/agent/src/routes/session-context.ts`: extract `handlePatchSessionContext`'s [beads:nx-41fhv]
  validation + `store.set(id, {...})` write into a shared internal function (e.g.
  `_writeContextEntry(id, usedPercentage, contextWindowSize)`), then export a new function (e.g.
  `applyStatuslineSnapshot(id: string, usedPercentage: number, contextWindowSize: number | null):
  void`) that calls it directly — this is the in-process write path the poller (API batch) calls,
  no HTTP round-trip. `handlePatchSessionContext` itself is refactored to call the SAME shared
  internal function rather than duplicating the write logic — do not change its own validation
  contract (`sessionContextPatchInput` schema, 204/400 responses) at all. [owner:general-purpose] [type:api]

## API Batch

- [x] [2.1] Add `apps/agent/src/services/statusline-ctx-poller.ts`: a persistent poller mirroring [beads:nx-6a5fv]
  `process-watcher.ts`'s own start/stop lifecycle pattern (read that file's `startProcessWatcher`/
  `ProcessWatcherHandle` shape first, match its style). On each tick (proposed interval: 3
  seconds — see design.md § Poll cadence for the rationale), list
  `~/.claude/scripts/state/statusline-ctx.*.json` (reuse `cache-io.ts`'s `STATE_DIR` constant if
  it's importable from `apps/agent`, otherwise mirror its `join(homedir(), '.claude/scripts/
  state')` path construction exactly — check whether `apps/nexus-statusline`'s `cache-io.ts` is
  already a shared package `apps/agent` can import, or whether this needs its own small
  file-listing helper; do not duplicate `writeJsonAtomic`/`readJsonCache`, only the LIST-then-
  READ-then-apply logic is new here), extract the session id from each filename (the part between
  `statusline-ctx.` and `.json`), parse the file's `{used_percentage, context_window_size,
  saved_at}` (seconds) shape, skip any file whose `saved_at` is older than the existing 600s
  freshness convention (`session-context.ts`'s `CACHE_TTL_MS`, or the analogous constant this
  poller should share/import rather than re-hardcode), and call `applyStatuslineSnapshot(id,
  used_percentage, context_window_size)` (task 1.1) for each fresh one. Malformed/unreadable
  files are skipped silently (fail-soft, matching this codebase's universal convention for
  file-cache reads). Export a `startStatuslineCtxPoller(): StatuslineCtxPollerHandle` (with a
  `stop()` method) mirroring `ProcessWatcherHandle`'s shape. [owner:general-purpose] [type:api]
- [x] [2.2] `apps/agent/src/server.ts`: start the poller (task 2.1) alongside [beads:nx-mq8ht]
  `startProcessWatcher(db)` (same section, same lifecycle — read the surrounding code first to
  match exactly how `processWatcher`'s handle is stored/stopped on server teardown, and do the
  same for the new poller's handle). [owner:general-purpose] [type:api]
- [x] [2.3] `apps/nexus-statusline/src/context-guard.ts`: remove the fire-and-forget [beads:nx-uvly3]
  `pushContext` HTTP call sites in `resolveContext` (both the "populated frame" branch and the
  "suspicious zero, restore fresh snapshot" branch each currently call `pushContext(...)` —
  remove BOTH call sites) and the now-unused `defaultPushContext`/`CtxResolverDeps.pushContext`
  plumbing this function no longer needs — but do NOT touch the local snapshot read/write
  logic itself (`writeSnapshot`/`readSnapshot`/the write-throttle/"suspicious zero" restore
  branching) — that stays exactly as-is, since the poller (task 2.1) now depends on this exact
  snapshot file continuing to be written reliably. Update the function's own docstring to
  describe the new architecture (local snapshot only, no network push — the persistent nx-agent
  poller reads the snapshot directly) instead of the removed push behavior.
  [owner:general-purpose] [type:api]

## E2E Batch

- [x] [3.1] Add `apps/agent/src/services/statusline-ctx-poller.test.ts` covering the pure parsing/ [beads:nx-cbbm6]
  matching logic from task 2.1: a well-formed `statusline-ctx.<uuid>.json` fixture (using a
  temp/mocked state dir, not the real `~/.claude/scripts/state`) is parsed and applied correctly;
  a file whose `saved_at` exceeds the freshness window is skipped, not applied; a malformed file
  (bad JSON, missing fields) is skipped without throwing; an empty directory produces zero
  applies. Also test `applyStatuslineSnapshot` (task 1.1) directly: after calling it, a subsequent
  `handleGetSessionContext` call for the same id returns the expected `usedPercentage`, and (given
  a `db` + a session row with a real `model`) the expected `model` letter — same assertion shape
  `reconcile-session-id-universes`'s own tests already use for this endpoint, follow that
  precedent rather than reinventing it. [owner:general-purpose] [type:testing]
- [x] [3.2] Extend test coverage for: (a) the poller's start/stop lifecycle (mirrors whatever [beads:nx-uku4j]
  test pattern `process-watcher.test.ts` uses for `startProcessWatcher`/`ProcessWatcherHandle` —
  follow it) — `stop()` actually halts further polling, no dangling timer/interval after stop;
  (b) `context-guard.test.ts` (or wherever `resolveContext`'s existing tests live — find and read
  them first): add/update a case asserting `resolveContext` makes ZERO network calls (a `fetch`
  spy with 0 invocations) while its existing "suspicious zero restore" and "populated frame
  refreshes snapshot" test cases still pass UNCHANGED (confirming the local snapshot behavior
  truly wasn't touched, only the push call sites were removed). Run this package's full test
  suite (both `apps/agent` and `apps/nexus-statusline` — check each package's own `package.json`
  test script) and paste the full passing output, zero failures.
  [owner:general-purpose] [type:testing]
- [x] [3.3] Live verification (not source-reading): with the fix deployed on this machine, DO NOT [beads:nx-wzbps]
  manually PATCH or manually invoke `nexus-statusline` — instead, let a REAL, currently-active
  Claude Code session render its OWN statusline naturally (any real turn in any real tmux pane on
  this machine), wait at least one poller interval (a few seconds) plus however long until the
  next natural statusline render, then query `GET /sessions/:id/context` for that session's real
  CC session UUID and confirm it returns fresh, non-stale data — this is the actual acceptance bar
  for `nx-ev2x5.3`: automatic, not manually-triggered. Also directly inspect
  `~/.claude/scripts/state/statusline-ctx.*.json` file mtimes to confirm NEW files are appearing
  on their own (not just the one pre-existing manual-test file from the investigation that
  preceded this spec) — paste both the HTTP response and the file-listing output.
  [owner:general-purpose] [type:testing]

  DONE — but this task surfaced a SECOND, deeper blocker beyond this spec's own fix, found and
  fixed in the same pass (tracked separately as `nx-ev2x5.4`, not scope creep on this spec's own
  6 tasks, which are complete and correct as shipped): the deployed `nexus-statusline` binary
  was 2 days stale (last built 2026-07-13T19:13) because `deploy/hooks.d/post-merge/02-deploy`
  never rebuilt/installed it — only `apps/agent/`. So this spec's poller/push-removal fix,
  though correctly built and tested, had nothing real to poll: the live binary predated ALL of
  today's `apps/nexus-statusline/` changes.

  Confirmed via a temporary capture shim (renamed the real binary, substituted a tee-and-exec
  wrapper capturing one real automatic invocation's stdin, restored the real binary immediately
  after — no lingering shim, capture file deleted). Real ccInput DID carry
  `context_window.used_percentage: 82-83` (refuting a "used_percentage never >0 in practice"
  theory as the sole blocker). After manually rebuilding+installing `nexus-statusline` from
  current source (`bun run build` + `install`), AND separately fixing `02-deploy` to always
  rebuild both binaries going forward, verified fully automatic end-to-end with ZERO manual
  PATCH/poll trigger:

  ```
  find ~/.claude/scripts/state -iname 'statusline-ctx.*' -printf '%T@ %p\n' | sort -rn
  1784089463.71 .../statusline-ctx.7a7a89eb-1eee-45ef-afe9-bf88e1dd2afa.json   (fresh, real, automatic)

  GET /sessions/7a7a89eb-1eee-45ef-afe9-bf88e1dd2afa/context
  {"sessionId":"7a7a89eb-...","usedPercentage":83,"contextWindowSize":1000000,
   "updatedAt":"2026-07-15T04:24:50.826Z","model":"S"}
  ```

  `deploy/hooks.d/post-merge/02-deploy` fix verified live via a real `--force` invocation:
  both `nexus-agent` and `nexus-statusline` binaries rebuilt and reinstalled in one run.
