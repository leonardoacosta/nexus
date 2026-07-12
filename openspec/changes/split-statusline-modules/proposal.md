# Split nexus-statusline's 1607-line index.ts along its 5 documented seams

## Why

`apps/nexus-statusline/src/index.ts` is 1607 lines and grew +131% in the six days before this
plan was written (639 lines on 2026-05-17 -> 696 on 2026-07-05 -> 1607 at `b7096486`), with four
feature commits in the final week — every new statusline feature currently lands in this one
file and its 1309-line twin test file. Its 22 `export` statements exist solely so `index.test.ts`
can import them (the file is the compiled bin entrypoint; nothing else imports it), meaning the
module boundaries already exist in all but file structure — the file even draws them itself with
`// --` banner comments.

Two concrete costs today:

1. The atomic-write cache idiom (`.tmp` sibling + `writeFileSync` mode `0o600` + `renameSync` +
   swallow-all catch) is triplicated, and the read-parse-validate cache reader is near-triplicated,
   inside the same file.
2. `apps/agent/src/services/statusline-usage-file.ts` hand-duplicates the `CachedUsage`/
   `UsageResponse`/`UsagePeriod` wire shape — its own doc comment says the shape "MUST match
   nexus-statusline's existing `CachedUsage` reader byte-for-byte" — because no importable
   boundary exists. Two processes share this file format with nothing but a comment enforcing it:
   a silent-drift bug waiting to happen.

This is the sole structural target approved out of the Wave-3 arch audit: the pre-existing
B3/B4 god modules elsewhere in the repo remain deferred (settled — do not touch them);
`apps/nexus-statusline/src/index.ts` newly crossed the size threshold after the prior
verification point and is fair game. This proposal executes plan 031, which explicitly required
maintainer go-ahead before scheduling (L-effort, structural) — that go-ahead is this `/feature`
invocation.

## What Changes

- Split `index.ts` into 9 single-responsibility modules along its own existing `// --` section
  boundaries (`cache-io.ts`, `types.ts`, `project.ts`, `render.ts`, `usage.ts`,
  `context-guard.ts`, `session-context.ts`, `speed.ts`, `agent-lines.ts`). `index.ts` shrinks to
  the compiled-binary entrypoint only: doc header, `readStdinInput`, `getGitStatus`, `main`, the
  `Bun.main` guard — zero exports when done.
- Consolidate the triplicated atomic-write idiom and the near-triplicated read-parse-validate
  reader into two shared helpers in `cache-io.ts` (`writeJsonAtomic`, `readJsonCache`), used by
  every cache-file site across the split modules.
- Extract the shared wire contract (`UsagePeriod`, `UsageResponse`, `CachedUsage`) into a new
  types-only, zero-dependency workspace package `packages/statusline-contract`, imported by both
  `apps/nexus-statusline` (reader) and `apps/agent/src/services/statusline-usage-file.ts`
  (writer) — so a future shape drift between the two processes becomes a `pnpm typecheck` failure
  instead of a silent on-disk format fork.
- Zero intended behavior change: every moved function keeps its exact body, every existing test
  in `index.test.ts` runs unmodified (only its import block is rewritten across the new modules).

## Context

- depends on: none (025/026/027 — the plans that edited the pre-split file's internals — are
  already shipped as of `harden-statusline-spawn-and-cache`, archived 2026-07-12)
- touches: `apps/nexus-statusline/src/index.ts`, `apps/nexus-statusline/src/cache-io.ts`,
  `apps/nexus-statusline/src/cache-io.test.ts`, `apps/nexus-statusline/src/types.ts`,
  `apps/nexus-statusline/src/project.ts`, `apps/nexus-statusline/src/render.ts`,
  `apps/nexus-statusline/src/usage.ts`, `apps/nexus-statusline/src/context-guard.ts`,
  `apps/nexus-statusline/src/session-context.ts`, `apps/nexus-statusline/src/speed.ts`,
  `apps/nexus-statusline/src/agent-lines.ts`, `apps/nexus-statusline/src/index.test.ts`,
  `apps/nexus-statusline/package.json`, `apps/nexus-statusline/tsconfig.json`,
  `packages/statusline-contract/package.json`, `packages/statusline-contract/tsconfig.json`,
  `packages/statusline-contract/src/index.ts`, `apps/agent/package.json`,
  `apps/agent/src/services/statusline-usage-file.ts`, `pnpm-lock.yaml`

No conflicts with the only other in-flight proposal (`ios-session-navigation`, Swift/agent-WS
territory, disjoint files). No soft dependencies.

**Design decision (already made in the source plan, not re-opened here)**: the shared contract
lives in a new tiny `packages/statusline-contract` (Option B), not as a type re-export from
`packages/core` (Option A). Rationale: `apps/nexus-statusline` is a zero-workspace-dependency
compiled binary (`bun build --compile`) today; `packages/core` pulls in `@nexus/db`, pino, five
OpenTelemetry packages, zod, and protobuf. `import type` is erased at compile time so importing
from core would stay build-safe today, but the first future value-import from core into
statusline would silently bundle that whole dependency graph into the binary. A dedicated
types-only package makes the compile-safety property structural rather than a discipline anyone
could break by accident.

**Explicitly NOT in scope** (per the source plan): any behavior change inside moved code
(spawn-site shapes, cache GC/staleness/tmp-naming behavior, `writeSessionContext`'s settled
null-`usedPct` guard — moved verbatim, not "fixed"); `apps/nexus-statusline/package.json`'s
`test` script value; splitting `index.test.ts` beyond its import block; the six pre-existing
>=500-line files elsewhere in the repo (separately deferred); anything under `packages/db/**`,
`deploy/**`, or the Drizzle schema (migration-only policy, unaffected — nothing here touches the
DB).

## Testing

- **New**: `apps/nexus-statusline/src/cache-io.test.ts` — 6 cases (round-trip write+read,
  missing-file read, corrupt-JSON read, validator reject/accept, write-to-unwritable-path
  no-throw, no leftover `.tmp` sibling after a successful write).
- **Existing suite as the regression harness**: all 113+ tests in `index.test.ts` are the
  behavioral spec for every moved function; they run unmodified (bodies untouched, only the
  import block rewritten across 9 new module files) at every intermediate step — passing them at
  a stable count after each step is the proof the split changed nothing.
- **Contract enforcement is itself the test**: after the contract package lands, the agent-side
  writer types its payload as the imported `CachedUsage` — a future shape drift between writer
  and reader becomes a `pnpm typecheck` failure, not a silent runtime format fork. No new test
  needed to prove this; the type system is the enforcement mechanism.
- **Runtime evidence required**: a real compiled-binary smoke test — pipe a fixture stdin frame
  through `./nexus-statusline` post-build and confirm the rendered line contains the expected
  context/model tokens, proving the module split composes correctly through `bun build --compile`
  and not just through the test runner's module resolution.
