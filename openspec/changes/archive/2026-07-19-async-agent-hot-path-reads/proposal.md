---
order: 0719b
---

# Proposal: Async Agent Hot-Path Reads

## Change ID
`async-agent-hot-path-reads`

## Summary
Convert three synchronous filesystem reads on the Bun agent's socket-ingest and spec-request hot
paths to async (`node:fs/promises`), so they stop blocking the single event loop under real
transcript/repo sizes.

## Context
- Extends: `apps/agent/src/services/context-usage-collector.ts`, `apps/agent/src/services/bead-rollup.ts`, `apps/agent/src/routes/specs.ts`
- Related: `improve:code` audit run 2026-07-19 (`docs/audit/apply-2026-07-19-001/`), findings PERF-SYNC-01/02/03, adversarially confirmed at base commit `c25cd89d`. `docs/audit/false-positives.md` already documents the accepted-sync baseline these three findings were carved out of (startup/poller/atomic-flush/procfs sync reads are explicitly OUT — see Scope below).
- touches: `apps/agent/src/services/context-usage-collector.ts`, `apps/agent/src/services/context-usage-collector.test.ts`, `apps/agent/src/services/bead-rollup.ts`, `apps/agent/src/routes/specs.ts`

## Motivation
`collectContextUsage` (context-usage-collector.ts:105) does a whole-transcript `readFileSync` +
`content.split("\n")` on EVERY `tool_use_end`/`user_prompt` socket event
(process-hook-event.ts:163). Transcripts are 6-9MB routinely (20MB+ observed) and grow through a
session; this blocks the Bun process's single event loop on the hottest socket-ingest path and
allocates O(file-size) per event. The in-code justification comment ("simple and sufficient at
this call frequency") predates the realization that "this call frequency" is per tool event
across every concurrent session, not a bounded poll.

`resolveTasksMd` (bead-rollup.ts:269,279) does sync `readFileSync` + `readdirSync` archive scans
(206-387 entries in real fleet repos) per spec on `GET /specs/all` and `GET /specs/:project/:name`
— both inside `runPool(8)` (routes/specs.ts:94-104), whose bounded concurrency the sync reads
nullify by serializing on the event loop instead of actually running in parallel.

`readProposalFrontmatter` (routes/specs.ts:263,274,279) repeats the identical
sync-read-plus-archive-readdirSync-scan shape on `GET /specs/:project/:name`. It is a documented
mirror of `resolveTasksMd` (same lookup order: live dir, then archive by exact-name or
`-<specName>` suffix) and should share one resolver rather than duplicate the async conversion
twice.

`collectLinkedBeadIds` in the same `bead-rollup.ts` file already uses the target idiom
(`fs/promises` `readdir`/`readFile`) — it is the in-repo exemplar this proposal converts the
other two call sites to match, not a new pattern.

Source plan: audit finding IDs PERF-SYNC-01, PERF-SYNC-02, PERF-SYNC-03 (`improve:code`, base
commit `c25cd89d`, adversarially confirmed).

## Requirements

### Requirement: Bounded async tail-read for context-usage collection
`collectContextUsage` SHALL read only a bounded trailing window of the transcript file via
`node:fs/promises`, instead of a synchronous whole-file read, and SHALL remain a promise the
caller awaits without blocking the event loop for the file's full size.

### Requirement: Async tasks.md resolution in bead-rollup
`resolveTasksMd` SHALL resolve `tasks.md` (live then archive) using `node:fs/promises` reads
instead of synchronous `readFileSync`/`readdirSync`, preserving its existing live-then-archive
fallback contract and null-on-failure return.

### Requirement: Shared async frontmatter/tasks-md resolver
`readProposalFrontmatter` in `routes/specs.ts` and `resolveTasksMd` in `bead-rollup.ts` SHALL
share one async live-then-archive file resolver (parameterized by filename), instead of each
independently duplicating the sync lookup-and-fallback logic.

## Scope
- **IN**: async conversion of the three sync read sites named above (PERF-SYNC-01/02/03); a
  shared async resolver for the proposal/tasks live-then-archive lookup; extended unit tests for
  the tail-read window edge cases.
- **OUT**: every other sync I/O site in the agent (pollers, startup reads, `state-snapshot.ts`'s
  atomic tmp+rename flush, `nexus-emit` CLI, `memory-pressure.ts` procfs reads) — verified
  deliberate/accepted idiom per `docs/audit/false-positives.md`, left untouched. No behavior
  change to `usedPercentage`/`contextWindowSize` computation beyond the bounded-window read
  itself (same last-assistant-usage-line selection, same fail-soft null contract).

## Done Means
- Sending high tool-event volume against a session with a large (10MB+) transcript no longer
  measurably stalls concurrent socket-ingest processing on the same agent process.
- `GET /specs/all` and `GET /specs/:project/:name` continue to return identical payloads to
  today, but their per-spec tasks.md/proposal.md reads no longer serialize on the event loop
  inside `runPool(8)`.
- Specs refresh in the Swift dashboard no longer stalls behind socket ingest under load.

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `collectContextUsage` tail-read window | `[2.2]` | N/A — no user-facing flow, covered by unit fixtures |
| `resolveTasksMd` async conversion | `[2.4]` | N/A — behavior-preserving; exercised indirectly by existing `bead-rollup` route tests |
| `readProposalFrontmatter` / shared resolver | `[2.6]` | N/A — behavior-preserving; exercised indirectly by existing `specs.ts` route tests |

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/services/context-usage-collector.ts` | `collectContextUsage` becomes `async`, bounded tail-read via `fs/promises` |
| `apps/agent/src/services/process-hook-event.ts` | `await collectContextUsage(...)` (already an `async` call site) |
| `apps/agent/src/services/bead-rollup.ts` | `resolveTasksMd` becomes `async`, uses the shared resolver |
| `apps/agent/src/routes/specs.ts` | `readProposalFrontmatter`'s file-read step delegates to the shared resolver; `handleGetSpec` already `await`s it |

## Risks
| Risk | Mitigation |
|------|-----------|
| Bounded tail-read window misses the last usage line if a single JSONL line exceeds the window (unlikely but possible for a huge tool_result) | Fall back to reading from the start of file if no usable line is found inside the window, capped at the full-file size as today; covered by a dedicated unit test |
| Two call sites (`process-hook-event.ts`, both `specs.ts` handlers) must add `await` at their existing call sites | Both call sites are already inside `async` functions (confirmed by reading `process-hook-event.ts` and `handleGetSpec`) — pure signature change, no control-flow restructuring needed |
