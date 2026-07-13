<!-- beads:epic:nx-oxbf8 -->
<!-- beads:feature:nx-dt50d -->

# Tasks: add-session-context-model-field

## DB Batch

- [ ] 1.1 No schema change. `sessions.model` (text, nullable) already exists and is already [beads:nx-0dyaq]
      populated by `add-session-model-authority` — this proposal only reads it.
      - touches: (none)

## API Batch

- [ ] 2.1 Add `model: string | null` to `SessionContextResponse` in [beads:nx-eni36]
      `packages/core/src/types/session-context.ts`, updating the doc comment to describe it as
      the derived single-letter family tag (matching `GET /statusline`'s convention), refreshed
      per request, not cached.
      - touches: `packages/core/src/types/session-context.ts`
- [ ] 2.2 In `apps/agent/src/routes/session-context.ts`: make `handleGetSessionContext` accept an [beads:nx-b2wlo]
      optional `db?: Db` parameter and become `async`; when `db` is present, call the existing
      `getSessionById(db, id)` from `../db/sessions`, derive the letter via the existing
      `modelFamilyLetter({ id: row?.model ?? undefined }) ?? null` from `@nexus/core`, and
      include it in the response body. When `db` is absent or `getSessionById` finds no row,
      `model` is `null` — never throw, never change the 404/stale-entry behavior. Thread the
      already-passed `db` argument from `tryHandleSessionContextRoute` through to this call
      (the dispatcher already receives `db` at its one call site in
      `server-request-handler.ts:348` — no dispatcher signature change needed since it already
      returns `Response | Promise<Response>`). Update the file's header comment (currently says
      the `db?` param "mirrors the sibling dispatcher signature convention but is unused") to
      reflect that it is now used for the model lookup.
      - touches: `apps/agent/src/routes/session-context.ts`
      - depends on: (none — task 2.1 lands first within this same batch)
- [ ] 2.3 Unit tests in `apps/agent/src/routes/session-context.test.ts`: `handleGetSessionContext` [beads:nx-ud0ef]
      with a mocked `db`/`getSessionById` returning a row with `model: "claude-opus-4-8"` returns
      `model: "O"`; with a row whose `model` is `null`, or with `getSessionById` returning `null`,
      or with `db` omitted entirely, returns `model: null` alongside the existing fields (never a
      thrown error or a changed status code for the fresh/stale/unknown-session cases already
      covered by the existing suite).
      - touches: `apps/agent/src/routes/session-context.test.ts`

## UI Batch

- [ ] 3.1 No UI change in this proposal — the only consumer (cc-tmux) lives in a separate repo [beads:nx-tom28]
      and is out of scope here (see proposal.md Non-Goals).
      - touches: (none)

## E2E Batch

- [ ] 4.1 No E2E change — backend response-shape addition only, no nx-owned user-facing flow to [beads:nx-dfjnl]
      exercise (see proposal.md Testing).
      - touches: (none)
