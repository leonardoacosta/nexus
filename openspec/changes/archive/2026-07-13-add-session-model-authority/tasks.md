<!-- beads:epic:nx-f8ahu -->
<!-- beads:feature:nx-iwk95 -->

# Tasks: add-session-model-authority

## DB Batch

- [x] 1.1 No schema change. `sessions.model` (migration 0005) already exists as a `text` column [beads:nx-fjr6s]
      — this proposal changes what writes to it and what reads from it, not its shape.
      - touches: (none)

## API Batch

- [x] 2.1 Add `packages/core/src/model-letter.ts` exporting `modelFamilyLetter(model?: { id?: [beads:nx-w581i]
      string; display_name?: string }): string | null`, ported from
      `apps/nexus-statusline/src/render.ts`'s existing implementation (fable/opus/sonnet/haiku →
      F/O/S/H via lowercase substring match on `id`+`display_name`; unknown family → uppercased
      `display_name` initial, falling back to `id`'s initial; no model → `null`). Export it from
      `packages/core/src/index.ts`.
      - touches: `packages/core/src/model-letter.ts`, `packages/core/src/index.ts`
- [x] 2.2 Add a write-through helper in `apps/agent/src/db/sessions.ts`, [beads:nx-zkqs2]
      `updateSessionModel(db, sessionId, model: string)`, that sets `sessions.model` only when
      `model` is a non-empty string (mirrors the fail-soft/no-clobber shape of the existing
      `updateSessionAgentState` helper in the same file).
      - touches: `apps/agent/src/db/sessions.ts`
- [x] 2.3 In `apps/agent/src/services/process-hook-event.ts`, call `updateSessionModel` when [beads:nx-cnql9]
      `input.payload.model` (or the flattened `HookEventInput` equivalent) is a non-empty string
      and `input.sessionId` is set — fire-and-forget, logged and swallowed on failure, matching
      this file's existing enrichment-branch error-handling convention. Wire this for the
      `session_start` case.
      - touches: `apps/agent/src/services/process-hook-event.ts`
      - depends on: (none — task 2.2 lands first within this same batch)
- [x] 2.4 In `apps/agent/src/services/socket-server/dispatcher.ts`'s `session_heartbeat` case, [beads:nx-6jxsv]
      call `updateSessionModel` when `event.model` is a non-empty string (mirrors the existing
      `deriveAndPersistAgentState` call already made in that same case branch).
      - touches: `apps/agent/src/services/socket-server/dispatcher.ts`
      - depends on: (none — task 2.2 lands first within this same batch)
- [x] 2.5 In `apps/agent/src/routes/statusline.ts`, replace the hardcoded `model: null` (line [beads:nx-xgt36]
      ~125) with `modelFamilyLetter({ id: s.model ?? undefined }) ?? null` (imported from
      `@nexus/core`), so the response derives a letter from the row's raw stored value instead
      of a literal.
      - touches: `apps/agent/src/routes/statusline.ts`
      - depends on: (none — task 2.1 lands first within this same batch)
- [x] 2.6 Update `apps/nexus-statusline/src/render.ts` to import `modelFamilyLetter` from [beads:nx-pun8v]
      `@nexus/core` instead of keeping its own copy; `modelEffortToken` keeps its own local
      effort-suffix logic (out of scope — only the family-letter half moves).
      - touches: `apps/nexus-statusline/src/render.ts`
      - depends on: (none — task 2.1 lands first within this same batch)
- [x] 2.7 Unit tests: `packages/core`'s `model-letter.test.ts` (ported from [beads:nx-5qs3u]
      `apps/nexus-statusline/src/render.test.ts`'s existing `modelFamilyLetter` cases);
      `process-hook-event.test.ts` / `dispatcher.test.ts` covering session_start persist +
      session_heartbeat last-write-wins + no-model-no-clobber; `statusline.test.ts` covering the
      derived-letter response shape.
      - touches: `packages/core/src/model-letter.test.ts`, `apps/agent/src/services/process-hook-event.test.ts`, `apps/agent/src/services/socket-server/dispatcher.test.ts`, `apps/agent/src/routes/statusline.test.ts`

## UI Batch

- [x] 3.1 No new UI — `apps/nexus-statusline`'s render output is unchanged (same letter, same [beads:nx-hri7x]
      position); only its source of the mapping function moves. No dashboard UI consumes
      `GET /statusline`'s `model` field yet in this proposal (that's a future dashboard-side
      follow-up, not blocked by this work).
      - touches: (none)

## E2E Batch

- [x] 4.1 No E2E change — no new user-facing flow to exercise; existing statusline rendering [beads:nx-tonnj]
      behavior is unchanged (verified by unit coverage in task 2.7).
      - touches: (none)
