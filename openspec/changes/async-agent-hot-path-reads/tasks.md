---
stack: t3
---
<!-- beads:epic:nx-5qac0 -->
<!-- beads:feature:nx-7dm13 -->

<!-- stack: one of t3 | cc-meta | effect | dotnet — see commands/apply/references/stacks.md § "Stack vocabulary crosswalk" for the full tasks.md-stack:/--stack-profile/detect_stack() mapping -->

# Implementation Tasks

## API Batch

- [ ] [2.1] Convert `collectContextUsage` in `apps/agent/src/services/context-usage-collector.ts` to an async, bounded tail-read: `fstat` the file, read only the last ~256KB window via `node:fs/promises`, backward-scan for the last `assistant`-with-`message.usage` line within that window; when no usable line is found inside the window, fall back to reading from the start of the file (same as today's full read); preserve the null-on-failure / never-throw contract and the existing `usedTokens`/clamp computation unchanged. [beads:nx-il3ln]

- [ ] [2.2] Extend `apps/agent/src/services/context-usage-collector.test.ts` with tail-read window edge cases: file smaller than the window (reads whole file, same result as before), a transcript whose last usable `assistant` line falls just inside vs. just outside the window boundary, a last line truncated mid-write (falls back gracefully, still returns the last complete usable line or `null`), and a missing file (still resolves to `null`). [beads:nx-61h24]
  - depends on: 2.1

- [ ] [2.3] Update the call site in `apps/agent/src/services/process-hook-event.ts` (currently `const usage = collectContextUsage(transcriptPath);` around line 163) to `await` the now-async `collectContextUsage`; the enclosing function is already `async`, so this is a signature-only change with no control-flow restructuring. [beads:nx-60l2v]
  - depends on: 2.1

- [ ] [2.4] Convert `resolveTasksMd` in `apps/agent/src/services/bead-rollup.ts` (currently sync `readFileSync`/`readdirSync` at lines 269 and 279) to async, using `node:fs/promises` `readFile`/`readdir` — mirror the existing `collectLinkedBeadIds` in the same file, which already uses this idiom. Preserve the exact live-then-archive lookup order (exact spec-name match or `-<specName>` suffix) and the null-on-failure contract. Update both call sites in the same file (currently lines 361 and 430) to `await` the result. [beads:nx-rmrkv]

- [ ] [2.5] Extend `apps/agent/src/services/bead-rollup.test.ts` with coverage asserting `resolveTasksMd` still resolves live-then-archive correctly (live hit, archive exact-name hit, archive suffix hit, neither exists returns `null`) after the async conversion. [beads:nx-fvtxb]
  - depends on: 2.4

- [ ] [2.6] Extract a shared async live-then-archive file resolver (parameterized by target filename, e.g. `tasks.md` vs `proposal.md`) used by both `resolveTasksMd` in `apps/agent/src/services/bead-rollup.ts` and `readProposalFrontmatter` in `apps/agent/src/routes/specs.ts` (currently sync `readFileSync`/`readdirSync` at lines 263, 274, 279 — a documented mirror of `resolveTasksMd`'s own lookup). `readProposalFrontmatter`'s frontmatter-parsing logic (the string-map extraction below the file read) stays in `routes/specs.ts`; only the file-read-plus-fallback step moves into the shared resolver. `handleGetSpec` already `await`s `readProposalFrontmatter`, so no caller-side control-flow change is needed there. [beads:nx-0fwjv]
  - depends on: 2.4

- [ ] [2.7] Add a short convention note (a code comment near `collectContextUsage`, or a `docs/` note if a natural home already exists) distinguishing sync-ok sites (one-shot startup reads, bounded pollers, `state-snapshot.ts`'s atomic tmp+rename flush, `nexus-emit` CLI, `memory-pressure.ts` procfs reads — all deliberately left untouched, see `docs/audit/false-positives.md`) from async-required sites (recurring reads on growing files inside a request/ingest path, the class this proposal fixes). [beads:nx-0cv1g]

- [ ] [2.8] Run `bun test` for the agent package and confirm the extended context-usage-collector, bead-rollup, and specs.ts test suites pass; run `pnpm --filter @nexus/agent typecheck` (the project's `[stack.gates] api` gate) and confirm zero errors. [beads:nx-6yxaz]
  - depends on: 2.2, 2.3, 2.5, 2.6
