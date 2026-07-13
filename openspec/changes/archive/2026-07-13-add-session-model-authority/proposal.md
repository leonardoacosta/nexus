# Add session model authority

## Context

Originated from `/openspec:explore` (2026-07-13) investigating why cc-tmux and nexus-statusline
each re-derive the active model's single-letter tag (F/O/S/H) locally instead of trusting nx.

`sessions.model` (`packages/db/src/schema/sessions.ts`, migration 0005) already exists as a
column, but it is dead data: the only writer is the managed-spawn route
(`apps/agent/src/routes/sessions.ts:397`), which sets the placeholder literal `"claude"` and
never updates it. The hook-ingest spine already receives real model data — both `session_start`
and `session_heartbeat` socket event shapes (`apps/agent/src/types/socket-events.ts`) declare an
optional `model?: string` field — but `session_start`'s value is only used for a log line and an
in-memory `lifecycleBus.emit`, and `session_heartbeat`'s is read nowhere at all. Neither
`process-hook-event.ts` nor `socket-server/dispatcher.ts` ever writes it to the `sessions` row.
Downstream, `GET /statusline` (`apps/agent/src/routes/statusline.ts:125`) hardcodes
`model: null` in its response for every session, despite the row already carrying (dead) data in
that column.

Meanwhile the only place the actual model→letter mapping exists is
`apps/nexus-statusline/src/render.ts`'s `modelFamilyLetter()` — local to that one app package,
not shared via `packages/core`. cc-tmux (a separate repo, `~/dev/personal/installfest`) doesn't
derive the letter itself; it reads a per-pane `session-context.<pane>.json` file that
nexus-statusline rewrites every render. That file mechanism is inherently single-machine
(keyed on a local tmux pane id) — it has no way to represent a session nx already knows about
via its DB/socket ingest but that isn't the locally-focused CC pane (a background session, a
session on another machine, a Swift dashboard row).

cc-tmux's own code history is instructive here: an earlier revision captured the model letter
from the `SessionStart` hook payload alone into a tmux option, and abandoned it — code comments
in that repo say it was "confirmed empty on every live pane" and "misses mid-session `/model`
switches." Any fix in nx that persists `sessions.model` only at `session_start` would reproduce
that exact bug. `session_heartbeat` already carries a `model` field in its wire schema for
exactly this reason (CC's own hook payloads include `model` on every hook invocation, not just
`SessionStart`) — the fix must persist on any event carrying a fresh value, last-write-wins.

- depends on: (none)
- touches: `packages/core/src/model-letter.ts` (new), `apps/agent/src/services/process-hook-event.ts`, `apps/agent/src/services/socket-server/dispatcher.ts`, `apps/agent/src/db/sessions.ts`, `apps/agent/src/routes/statusline.ts`, `apps/nexus-statusline/src/render.ts`

## What Changes

- Add a shared `modelFamilyLetter(model: { id?: string; display_name?: string }): string | null`
  utility to `packages/core` (new module, e.g. `packages/core/src/model-letter.ts`), ported from
  `apps/nexus-statusline/src/render.ts`'s existing implementation (same substring-family-match
  logic: fable/opus/sonnet/haiku → F/O/S/H, unknown family → uppercased `display_name` initial,
  no model → `null`). `apps/nexus-statusline/src/render.ts` re-exports or imports this shared
  version instead of keeping its own copy — one canonical mapping, not two.
- Persist the RAW model string (not just the derived letter) into `sessions.model` on any hook
  event whose payload carries a non-empty `model` value — both `session_start` and
  `session_heartbeat` today, last-write-wins (a later event's value replaces an earlier one).
  Storing the raw value rather than a pre-derived letter means a future change to the
  family-mapping heuristic never requires a data backfill.
- `GET /statusline`'s `StatuslineSession.model` stops hardcoding `null`: it derives the letter
  from the row's raw `model` via the new shared `packages/core` function at serve time.

## Non-Goals

- Does NOT require cc-tmux (a separate repo) or nexus-statusline's own per-pane rendering path
  to switch to consuming nx's `/statusline` response instead of their current local derivation.
  nexus-statusline already gets fresher model data for free from CC's own stdin on every
  invocation — no round trip through nx is needed or proposed for its own-pane render. The gap
  this closes is for OTHER consumers of nx's DB/API (Swift dashboard rows, any cross-machine or
  non-focused-pane session view) that currently get `model: null` with no fallback at all.
- Does NOT change `session_start`/`session_heartbeat` wire schemas beyond what already exists —
  both already declare `model?: string`; this proposal only wires the existing field through to
  persistence, it doesn't add new fields to the socket event contract.
- Does NOT touch cc-tmux's or nexus-statusline's session-context.<pane>.json file format.

## Testing

- Unit: `modelFamilyLetter` in `packages/core` — existing coverage from
  `apps/nexus-statusline/src/render.test.ts` (family substring match, unknown-family fallback,
  no-model → null) ports to (or is re-exercised against) the new shared module location.
- Unit: a hook-ingest test asserting `sessions.model` is updated (not just logged) when
  `process-hook-event`/dispatcher receives a `session_start` event with `model: "claude-opus-4-8"`,
  AND when a later `session_heartbeat` for the same session carries a different `model` value
  (last-write-wins) — see `apps/agent/src/services/process-hook-event.test.ts` /
  `apps/agent/src/services/socket-server/dispatcher.test.ts`.
- Integration: `GET /statusline` for a session whose row has `model: "claude-opus-4-8"` returns
  `sessions[].model === "O"` (not `null`) — see `apps/agent/src/routes/statusline.test.ts`.
- No E2E — no new user-facing flow; existing statusline/dashboard consumers already read this
  field, they just start receiving real data instead of `null`.
