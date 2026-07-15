# Design: detach-context-push-from-statusline-lifecycle

## Context

Filed as `nx-ev2x5.3` (parent epic `nx-ev2x5`). Confirmed live 2026-07-15: `nexus-statusline`
renders correctly on every Claude Code render (visually verified) and its context-window PATCH
mechanism (`context-guard.ts`'s `resolveContext` → `pushContext`) is functionally correct in
isolation — manually invoking the real binary with a realistic payload succeeds end-to-end
(`PATCH` 204, `GET` 200 with real data) every time, no exceptions. Yet `find
~/.claude/scripts/state -iname 'statusline-ctx.*'` showed exactly ONE such cache file on the
entire machine — created by that one manual test — meaning a REAL, automatic invocation has
never once completed this push, for any session, ever observed.

## Root cause

Per Claude Code's own documented statusline behavior: *"If a new update triggers while your
script is still running, the in-flight execution is cancelled."* `nexus-statusline` is a
short-lived process invoked fresh on every render. `pushContext` fires an **unawaited**
`fetch()` — the caller (the render's main function) does not wait for it; the process reaches
the end of its synchronous work, writes stdout, and the runtime lets it terminate. Any pending
async I/O (the fetch) has no independent existence past that — the moment CC's *next* statusline
trigger fires (which per the docs happens by cancelling the current invocation), whatever push
was still in flight is killed. Since CC's statusline re-trigger cadence is fast relative to even
a localhost network round-trip under real-world scheduling jitter, this cancellation wins nearly
every time in production — matching the observed "zero successful automatic pushes ever."
Exact signal/timing (SIGTERM vs SIGKILL, precise relationship to stdout-flush) is undocumented;
not needed to fix this, since the fix removes the race entirely rather than tuning around it.

**Not affected, checked and ruled out**: `agent-lines.ts`'s `fetchStatusline` and `usage.ts`'s
credential fetch are both `await`ed by the render's own main path (the rendered 5H/7D/account
segments and agent lines directly depend on their result) — the process cannot reach stdout
without them resolving first, so they never race cancellation the way an unawaited background
push does. This matches live behavior: 5H/7D renders correctly and reliably; only the
context-window push (whose result the render does NOT depend on, by design — it's a pure side
effect) is silently lost.

## Fix: read the existing reliable local snapshot instead of pushing over a race-prone network call

`context-guard.ts` already writes a **synchronous, atomic** local snapshot on every render with
live data — `writeJsonAtomic(statePath('statusline-ctx.<sessionId>.json'), {used_percentage,
context_window_size, saved_at})` (`cache-io.ts`'s `writeJsonAtomic`: `writeFileSync` + `renameSync`,
both synchronous, no async gap, cannot be cancelled mid-write the way a fetch can). This file
write already happens reliably today — it's the snapshot `resolveContext` itself reads back on a
"suspicious zero" frame. It is NOT vulnerable to the cancellation race because it completes
before the process's synchronous work (including stdout) finishes.

Instead of also trying to push that value over the network from the short-lived process, **the
persistent `nx-agent` process reads these files directly** — it already runs continuously (unlike
`nexus-statusline`), so it can poll the same local `~/.claude/scripts/state/` directory the way
`process-watcher.ts` already polls `pgrep`+`tmux` on its own cadence, and load each
`statusline-ctx.<sessionId>.json` file's contents straight into the existing in-memory
`session-context.ts` `store` Map — the SAME store `handleGetSessionContext` already reads.
`handleGetSessionContext`'s own logic (freshness check, `getSessionByCcSessionId` model lookup)
needs ZERO changes — it only cares that `store.get(id)` returns a fresh entry, not how it got
there.

This eliminates the race structurally rather than tuning timeouts: there is no longer any async
work whose survival depends on a short-lived process's lifetime. The poller is the reader; the
writer is a synchronous, already-proven-reliable file write.

**The existing fire-and-forget `pushContext` HTTP call in `context-guard.ts` is removed** —
Reader Gate: it has a 0% real-world success rate per live evidence, keeping it as a "sometimes
gets lucky" fallback adds a maintained code path for effectively no benefit once the poller is
authoritative. `resolveContext`'s OWN local snapshot read/write behavior (the "suspicious zero"
restore logic) is unchanged — only the network-push call site is deleted.

**Per-machine scope, matching existing architecture**: `nx-agent` polls its OWN machine's local
`~/.claude/scripts/state/` directory — consistent with how `process-watcher.ts` already resolves
sessions per-machine via local `pgrep`/`tmux`. A remote agent (e.g. the macbook-pro deploy target
already referenced in this repo's deploy output) runs its own `nx-agent` instance polling its own
local state dir for its own machine's sessions — no cross-machine file access is introduced.

**Poll cadence and staleness trade-off**: the poller runs on a fixed interval (proposed: 3s,
faster than the render cadence is likely to matter for a status display, slower than would add
meaningful CPU/IO load — mirror `process-watcher.ts`'s own interval choice/rationale if it
documents one, otherwise this is a reasonable default subject to adjustment). This trades a few
seconds of staleness for actually working, versus the fire-and-forget push's near-zero real
success rate today. `handleGetSessionContext`'s existing 600s TTL freshness gate is unaffected —
it already tolerates exactly this kind of "not updated every single render" staleness.

## Non-Goals

- No change to `agent-lines.ts`/`usage.ts`'s fetch patterns — confirmed unaffected (see Root
  Cause above), not in scope.
- No change to `handleGetSessionContext`/`handlePatchSessionContext`'s own route logic — the
  `PATCH` route stays in place (harmless, still callable, e.g. by a future genuinely-detached
  writer) even though `context-guard.ts` no longer calls it.
- No change to `getSessionByCcSessionId`/`updateSessionCcSessionId` (`nx-22xz8`) or the
  `reconcile-session-id-universes` correlation fix — this spec is purely about how the context
  VALUE reaches the store, not how a session's identity is resolved.
- No attempt to make the fire-and-forget push itself more reliable (shorter timeout, retry, etc.)
  — the race is structural, not a tuning problem; removing the race is the fix.
- No cross-machine polling — each `nx-agent` instance reads only its own local state dir.

## Testing

See `proposal.md` `## Testing`. The poller's file-parsing logic is a pure function (raw
directory listing + file contents → store entries) and is unit-testable without a live process,
mirroring this codebase's existing convention for `process-watcher.ts`'s own pure parsers.
