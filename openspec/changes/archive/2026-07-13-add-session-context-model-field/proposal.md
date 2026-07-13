# Add a model field to GET /sessions/:id/context

## Context

cc-tmux's row-2 status bar lost its model-letter (F/O/H/S) segment when it migrated off the
retired per-pane `session-context.<pane>.json` file onto `GET /sessions/:id/context`
(`SessionContextResponse` in `packages/core/src/types/session-context.ts`) — that endpoint
carries no model tag today (bead nx-da20s).

`add-session-model-authority` (archived earlier today, commit `dcb4bb57`) already solved the hard
part: it persists the RAW model string into `sessions.model` on every hook event carrying one
(`session_start` + `session_heartbeat`, last-write-wins — deliberately avoiding the "confirmed
empty on every live pane" / "misses mid-session `/model` switches" bug cc-tmux hit with its own
earlier, abandoned SessionStart-hook-only approach), added a shared
`modelFamilyLetter(model): string | null` mapping to `packages/core/src/model-letter.ts`, and
wired it into `GET /statusline` (`apps/agent/src/routes/statusline.ts:129`,
`modelFamilyLetter({ id: s.model ?? undefined }) ?? null`). It explicitly did not touch
`session-context.ts` or the `/sessions/:id/context` route — that's the gap this proposal closes.

Verified against live code, not just prose: `tryHandleSessionContextRoute` in
`apps/agent/src/routes/session-context.ts` already receives `db` at its one call site
(`server-request-handler.ts:348`, `tryHandleSessionContextRoute(request, url, db)`) but declares
it `_db?: Db` and documents it as unused ("this store is in-memory, not Postgres"). `db/sessions.ts`
already exports `getSessionById(db, id): Promise<SessionRow | null>` (a plain `select().from(sessions)
.where(eq(sessions.id, id)).limit(1)`), which returns a row already carrying the `model` column
(`sessions.ts` schema, `text("model")`). No new DB helper, no new schema column, no migration —
this is a wiring-through of three pieces that already exist, matching `GET /statusline`'s own
established pattern.

- depends on: (none)
- touches: `packages/core/src/types/session-context.ts`, `apps/agent/src/routes/session-context.ts`, `apps/agent/src/routes/session-context.test.ts`

## What Changes

- Add `model: string | null` to `SessionContextResponse`
  (`packages/core/src/types/session-context.ts`) — the derived single-letter family tag (matching
  `GET /statusline`'s convention), not the raw model string.
- Thread the already-passed-but-ignored `db` parameter from `tryHandleSessionContextRoute` into
  `handleGetSessionContext`, making it `async` (the dispatcher's `Response | Promise<Response>`
  return type already accommodates this — no change needed there).
- Inside `handleGetSessionContext`, when `db` is available: call the existing
  `getSessionById(db, id)`, derive the letter via the existing shared
  `modelFamilyLetter({ id: row?.model ?? undefined }) ?? null`, and include it in the response.
  Refreshed on every GET (not cached in the in-memory context-window entry) so it tracks
  mid-session `/model` switches the same way `GET /statusline` does today.
- Reuse `modelFamilyLetter` from `@nexus/core` — do not re-derive the family mapping locally.

## Non-Goals

- Do NOT reintroduce the rejected SessionStart-hook-payload-only capture mechanism cc-tmux's own
  history already tried and abandoned (empty on live panes; missed mid-session switches). This
  proposal only exposes data `add-session-model-authority` already persists correctly.
- No change to `PATCH /sessions/:id/context` — the model field is read-only, derived server-side;
  no client ever needs to write it.
- No change to the in-memory context-window store itself (`usedPercentage`/`contextWindowSize`
  stay exactly as they are) — `model` is looked up fresh from Postgres per GET, not stored in the
  `Map`.
- No change to `GET /statusline`, `modelFamilyLetter`, or `sessions.model`'s write path — all
  already correct per `add-session-model-authority`; this proposal is a pure read-side wiring
  addition to a second, already-existing endpoint.
- No cc-tmux-repo changes — that plugin's own consumption of this new field (bead nx-yn6c2,
  session_id capture) lives entirely in the cc-tmux/installfest repo, out of scope for nx.

## Testing

- Unit: `handleGetSessionContext`, given a session row with `model: "claude-opus-4-8"`, returns
  `model: "O"` in the response body alongside the existing fields — see
  `apps/agent/src/routes/session-context.test.ts` (extend the existing suite).
- Unit: given a session row with `model: null` or no matching session row at all, returns
  `model: null` (fail-open, matching `GET /statusline`'s `?? null` convention) — response is
  still `200` with the existing context-window fields intact, not a `404`/`500`.
- Unit: given `db` is unavailable (falsy), returns `model: null` without throwing — mirrors every
  other `if (db) { ... }`-gated route in `server-request-handler.ts`.
- No E2E/UI seam — this is a backend response-shape addition; cc-tmux (a separate repo) is the
  only real consumer and is out of scope here (see Non-Goals).
