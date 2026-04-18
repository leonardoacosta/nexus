# Proposal: Refactor Spec Watcher Service Split

## Change ID
`refactor-spec-watcher-service-split`

## Summary
Split `apps/agent/src/services/spec-watcher.ts` (707 lines) into concern-specific modules under a `spec-watcher/` directory: constants, parser (pure), poller (subprocess orchestration), watcher (fs.watch), tts, and lifecycle. Extract `parseSpecList`-type helpers so polling logic is unit-testable without spawning subprocesses. The lifecycle orchestrator (`startSpecWatcher`) stays as the public entrypoint via `index.ts`, which MUST remain ≤250 lines. The six bundled concerns (audit findings B4+I2+A11+A14) are all symptoms of the same split problem.

## Context
- Extends: `apps/agent/src/services/spec-watcher.ts`
- Related archives: `2026-04-17-split-b4-large-files` (decomposition pattern reference), `2026-04-17-cleanup-residual-debt` (sibling cleanup spec)
- Audit findings addressed: B4 (file >500 lines), I2 (deep nesting), A11 (magic numbers without owner), A14 (mixed responsibilities in one module)

## Motivation

`apps/agent/src/services/spec-watcher.ts` at 707 lines bundles six distinct concerns: timing constants, spec snapshot types and TTS formatting, polling coordination (subprocess orchestration across projects), filesystem watching (debounce, per-spec re-poll), TTS dispatch, and service lifecycle. Symptoms of this bundling include:

1. **Deep nesting (4-5 levels)** in `refreshSingleSpec` and `pollProjectSpecs` — these functions carry complexity from multiple layers simultaneously.
2. **Magic numbers at the top with no semantic owner** — `POLL_INTERVAL_MS`, `BATCH_SIZE`, `BATCH_DELAY_MS`, `SUBPROCESS_TIMEOUT_MS`, `COALESCE_DELAY_MS`, `WATCH_DEBOUNCE_MS` live together, but each belongs to a different sub-concern.
3. **Parser is untestable in isolation** — `parseSpecList`, `readProposalHash`, and `processProjectSpecs` share the file with subprocess-spawning and filesystem-watching code. A test for the parsing logic must reach through the whole file and either mock heavy dependencies or spawn real subprocesses.
4. **Module-level mutable state** — `projectState` Map and the active/degraded/pending watcher Maps are co-located, making state ownership invisible.

Splitting by concern gives each future reader a file that tells one story, makes `parser.ts` importable in a unit test without any subprocess or fs.watch mocking, and caps nesting by creating space for helper extraction.

**Investigation finding (2026-04-17):** `peer-connector.ts` and `cron.ts` do NOT use any of the 6 timing constants. The audit claim that these constants should be promoted to `@nexus/core/constants` for "a shared cadence ladder" is unsupported by the code. Constants remain local in `spec-watcher/constants.ts`.

## Requirements

### Requirement: Module decomposition by concern
`apps/agent/src/services/spec-watcher.ts` MUST be converted to a directory `apps/agent/src/services/spec-watcher/` containing ≥4 concern-specific modules. No file in the decomposition MAY exceed 250 lines. `index.ts` (the lifecycle module) is the sole public entrypoint.

Minimum decomposition:
- `constants.ts` — all 6 timing constants
- `parser.ts` — `SpecSnapshot` type, `parseSpecList`, `readProposalHash`, `processProjectSpecs`, `eventToMessage`
- `poller.ts` — `pollProjectSpecs`, `loadProjectRegistry`, subprocess helpers
- `watcher.ts` — `activeWatchers`, `watchDegraded`, `pendingSpecRefresh`, `refreshSingleSpec`, `startChangesFsWatchers`, `_getWatchDegradedForTest`
- `tts.ts` — `sendSpecTtsNotification`
- `index.ts` — `SpecWatcherService`, `startSpecWatcher`, `projectState`, `delay`, re-exports for public API

### Requirement: Pure parser layer
Parsing logic (`parseSpecList`, `readProposalHash`, `processProjectSpecs`, `eventToMessage`, `SpecSnapshot`) MUST live in `spec-watcher/parser.ts`, which MUST have no side effects. Specifically: no subprocess spawning, no `fs.watch` calls, no network I/O, no TTS. The module MUST be importable and fully testable in a unit test environment without mocking any of those systems.

### Requirement: Constants ownership — local
The 6 timing constants (`POLL_INTERVAL_MS`, `BATCH_SIZE`, `BATCH_DELAY_MS`, `SUBPROCESS_TIMEOUT_MS`, `COALESCE_DELAY_MS`, `WATCH_DEBOUNCE_MS`) MUST live in `apps/agent/src/services/spec-watcher/constants.ts`. They MUST NOT be promoted to `@nexus/core/constants` — no other file in the codebase uses these constants (verified: `peer-connector.ts` and `cron.ts` have no overlap).

### Requirement: Nesting ceiling
No function in any split module MAY exceed 3 levels of nesting. `refreshSingleSpec` and `pollProjectSpecs` (currently 4-5 levels) MUST have helpers extracted to bring them within the 3-level ceiling.

### Requirement: Backward compatibility
The public exports of the spec-watcher module (`startSpecWatcher`, `parseSpecList`, `_getWatchDegradedForTest`, `_projectState` test hook, and any other symbols currently exported by `spec-watcher.ts`) MUST remain importable from the same specifier. `index.ts` MUST re-export the full public surface. Consumers MUST NOT need to change import paths.

## Scope

**IN:**
- Decomposition of `apps/agent/src/services/spec-watcher.ts` into a directory with ≥4 modules
- Barrel re-exports from `index.ts` preserving every existing import path
- Helper extraction from `refreshSingleSpec` and `pollProjectSpecs` to cap nesting at 3 levels
- Unit tests for the parser module (no subprocess spawning)
- Line-count assertion (lint rule or test) that enforces the 250-line ceiling per file

**OUT:**
- Refactoring `peer-connector.ts`, `cron.ts`, or `server-request-handler.ts` (separate specs)
- Promoting constants to `@nexus/core` (unsupported by the evidence)
- Changing polling cadence, event shapes, TTS format, or any observable behavior
- Any API contract changes

## Impact

| Area | Change |
|------|--------|
| `apps/agent/src/services/spec-watcher.ts` | Replaced by `spec-watcher/index.ts` (lifecycle only, ≤250 lines); original path becomes the barrel or moves to directory |
| `apps/agent/src/services/spec-watcher/` (new dir) | 5-6 focused modules; ~707 lines redistributed, not removed |
| Public import paths | UNCHANGED — `index.ts` re-exports the full public surface |
| Tests importing `spec-watcher` public API | No changes needed — same import path resolves |
| Tests importing private internals (`_getWatchDegradedForTest`) | Re-exported from `index.ts`; imports unchanged |
| Type counts | No type additions or removals |

## Risks

| Risk | Mitigation |
|------|-----------|
| Splitting loses a closure reference — e.g., `parseSpecList` calling into module-level `projectState` | Keep `projectState` in `index.ts` (lifecycle module); thread it through function arguments into `parser.ts` so the parser has no implicit state dependency |
| Test files importing private helpers (`_getWatchDegradedForTest`, `_projectState`) break | Re-export all test hooks from `index.ts`; run `pnpm --filter @nexus/agent test` as the acceptance gate (task 1.9) |
| Circular imports — watcher imports poller imports parser imports watcher | Plan import flow as one-directional: `constants` → `parser` → `poller` / `watcher` → `tts` → `index`. Never import upward in this hierarchy |
| Scope creep into `@nexus/core` based on the "shared constants" audit claim | Investigation finding settles this: no overlap found. Local constants only. |
| `refreshSingleSpec` helper extraction changes observable retry timing | Extract only the structural nesting; do not change logic, conditions, or timing values during the extraction pass |
