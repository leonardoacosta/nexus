# Design: reconcile-session-id-universes

## Context

Filed as `nx-ev2x5.2` (parent epic `nx-ev2x5`, cc-telemetry-read). The bead's own investigation
correctly identified the shape of the problem but its "zero UUID rows exist" claim was a
point-in-time sampling artifact — re-verified live for this spec (see Evidence below) with a
different, more precise conclusion. This design supersedes the bead's own notes where they
differ; the bead stays open only as the tracking issue, not the source of truth once this lands.

## The bug, precisely

Every real Claude Code session currently creates **two** `sessions` rows that never link:

1. **Universe-1** (`process-watcher.ts`): discovered via `pgrep`+`tmux list-panes -a`, no CC hook
   involved. `id = cc-<pid>-<hash>`, `pid` = the real claude pid, `tmux_target` = `<session>:
   <window>.<pane>` form, `cc_session_id` = always null.
2. **Universe-2** (`session-manager.ts` `handleWatcherEvent`, fed by
   `socket-server/dispatcher.ts`'s `session_start` case): triggered by Claude Code's own hook
   (`~/.claude/scripts/hooks/telemetry.sh`) over the socket transport. `id = event.session_id`
   (confirmed live: this **is** `$CLAUDE_CODE_SESSION_ID`, the real hook UUID — not a
   regenerated/internal id), `pid = 0` (the hook sends no pid), `cc_session_id` = always null
   (the hook never sends a second, distinct `cc_session_id` field either — `session_id` IS the
   value that field is supposed to end up holding, just on the OTHER row).

Nothing links these two rows for the same real session. `sessions.cc_session_id` (added by
`nx-22xz8`, already shipped, lookup function already correct) never gets populated on either
row — universe-1 has no CC UUID to write there, and universe-2's own `id` already contains the
value but nothing copies it into the bridge column (nor should it need to — see Fix below).

**Downstream impact**: `cc-tmux` (a separate repo) queries `GET /sessions/:id/context` using the
real CC UUID it captures from its own hook. That endpoint's `model` field comes from
`getSessionByCcSessionId(db, id)` — which finds nothing, because no row's `cc_session_id` column
ever holds that UUID. Row 2's model-letter segment renders permanently blank.

## Evidence (live, re-verified for this spec — 2026-07-14)

- `~/.claude/scripts/hooks/telemetry.sh:544-546` (`handle_session_start`): payload is
  `project, model, tmux_target, effort_level` + whatever `json_event` always attaches
  (`session_id`, via `_session_id()` at line 449-453, which resolves
  `${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}`). **No `pid`. No separate `cc_session_id`
  field.** `tmux_target` IS sent, in tmux's raw `%N` pane-id form (`$TMUX_PANE`).
- `apps/agent/src/types/socket-events.ts:14-26` (`SessionStartEvent`): declares optional `pid`,
  `cc_session_id`, `tmux_target` — the hook populates only `tmux_target` of those three.
- `apps/agent/src/services/socket-server/dispatcher.ts:61-68`: copies the wire `session_id`
  verbatim into `watcherEvent.session_id` — no translation layer. Confirmed: `event.session_id`
  for a real production event **is** the real CC UUID.
- Live `sessions` table (docker `homelab-postgres`, db `nexus`): 21 rows with UUID-shaped `id`
  (2 currently `active`, 3 `ended`, 16 `stale`) vs. 6286 `cc-<pid>-<hash>`-shaped rows. **0** rows
  anywhere have a non-null/non-empty `cc_session_id`. The 2 active UUID rows at investigation
  time: `7a7a89eb-...` (installfest, `pid=0`) and `cfa3716e-...` (tribal-cities, `pid=0`) — both
  genuinely hook-created, both currently active, both unlinked to their sibling
  `cc-<pid>-<hash>` row for the same real session.
- Live agent journal (`journalctl --user -u nexus-agent`) confirms real `"socket: session_start"`
  events fire with UUID `sessionId`s and no `cc_session_id`/`model` — matching the code trace
  exactly, not a hypothetical.
- `queryActiveSessions` (`apps/agent/src/db/sessions.ts:448-461`) filters only by `status`, no
  pid/id-shape filter — so `/statusline`/`GET /sessions` already surface BOTH universes today,
  the bead's sample simply caught a moment with no UUID row mid-flight (they're ephemeral,
  flipping to `ended`/`stale` quickly once the CC Stop hook fires or the reaper marks them stale).

## Fix: merge, don't link two permanent rows

The two-separate-rows-linked-by-a-column shape (originally floated in the bead's own notes as
"expose cc_session_id on /statusline, keep both rows") is **rejected** — it would mean every real
session permanently owns two DB rows for its entire lifetime, one of which (`pid=0`, no working
data beyond `model`/`cwd`/`project`) exists purely as a correlation target. That is accidental
complexity for no benefit once correlation is possible at insertion time.

Instead: **when the socket `session_start` handler can identify the matching universe-1 row via
the tmux pane, write `cc_session_id` directly onto THAT row and do not create a second (universe-2)
row at all.** Concretely, in `socket-server/dispatcher.ts`'s `session_start` case, before calling
`sessionManager.handleWatcherEvent(watcherEvent)`:

1. Translate the hook's `tmux_target` (`%N` pane-id form) to `<session>:<window>.<pane>` form via
   one `tmux list-panes -a -F '#{pane_id}|#{session_name}:#{window_index}.#{pane_index}'` call —
   a single, cheap, already-precedented shell-out (mirrors `process-watcher.ts`'s own
   `listTmuxPanes`, which uses the same `tmux list-panes -a` command with a different format
   string; do not duplicate that function, add a small sibling helper since the format string
   differs and `listTmuxPanes` is private/unexported).
2. Query `sessions` for a row where `tmux_target` equals the translated value AND
   `status IN ('active', 'idle')`, excluding rows already carrying a `cc_session_id` (idempotency
   — a session_heartbeat firing this same branch a second time must not re-match/re-write). If
   multiple rows match (rare — stale unclosed rows sharing a reused pane), pick the one with the
   most recent `last_activity`.
3. **Match found**: call `updateSessionCcSessionId(db, matchedRow.id, event.session_id)` (already
   shipped, already correct, already idempotent/no-clobber per `nx-22xz8`) and **skip** the
   `handleWatcherEvent` call entirely — no universe-2 row is created for this session.
4. **No match found** (race: hook fires before process-watcher has discovered the pane yet, or
   `tmux_target` absent from the payload, or tmux itself unreachable): fall back to **today's
   unchanged behavior** — call `handleWatcherEvent` as-is. This is a strict regression guard: the
   new code path can only ADD correlation, never make an unmatched session worse than it is
   today. The resulting orphaned universe-2 row is a pre-existing, accepted degradation (same
   ephemeral-row lifecycle as today), not a new failure this spec introduces.

No backfill, no migration: existing historical UUID rows and `cc-<pid>-<hash>` rows for
already-ended sessions are left alone (Non-Goal) — they age out via the existing
stale/reaper logic untouched by this change.

## Non-Goals

- No change to `process-watcher.ts`'s own discovery/insertion logic — universe-1 row creation is
  untouched.
- No backfill of historical rows; only new `session_start` events benefit going forward.
- No change to `~/.claude/scripts/hooks/telemetry.sh` (a separate repo/global config) — this fix
  works entirely from data the hook ALREADY sends (`tmux_target`), no new hook field needed.
- No change to `getSessionByCcSessionId`/`updateSessionCcSessionId` (`nx-22xz8`, already correct)
  — this spec is purely about ensuring something actually calls the update with the right target
  row id.
- No change to `session-manager.ts`'s `handleWatcherEvent` itself — the fallback path still calls
  it unchanged; this spec only adds a pre-check before that call in the dispatcher.
- Does not address `nx-ev2x5.1` (the separate, dead `nexus-emit`/`/hooks` HTTP ingestion path) —
  unrelated transport, tracked separately.

## Testing

See `proposal.md` `## Testing` for the full seam table. Key point: the pane-translation helper is
a pure function (raw `tmux list-panes` output string → `Map<string,string>`) and is fully unit
testable without a live tmux server, following this codebase's existing convention for
`process-watcher.ts`'s own tmux-output parsers.
