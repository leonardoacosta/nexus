# Fix TypeScript Agent Quality — Vitest Migration + Error Handling

## Why
Two categories of correctness issues were found in the TypeScript agent and Next.js codebase:

1. **Test framework mismatch**: `apps/nextjs/src/lib/agent-client.test.ts` imports from `bun:test`
   but lives in a vitest project. This means the tests cannot run in the Next.js test suite and
   produce 9 `as unknown as FetchFn` double-casts to work around bun:test's Mock<T> type not
   overlapping with the native fetch signature.

2. **Silent async failures**: `apps/agent/src/watcher-bridge.ts` has an async IIFE (line 81)
   that reads from the watcher's stdout stream — its `catch` block is empty, meaning stream
   errors (EOF, pipe reset, process crash) disappear silently. `void stdin.flush()` on line 127
   similarly discards write errors. These are P1 because the watcher bridge is the critical path
   for session detection.

## What Changes

### 1. Migrate agent-client.test.ts to vitest
Replace `bun:test` imports with `vitest`. Use `vi.stubGlobal("fetch", impl)` instead of
wrapping `mock()` — this gives the correct `typeof fetch` type so all 9 double-casts disappear.
Restore `vi.restoreAllMocks()` in `afterEach` to replace the manual `restoreFetch()` pattern.

### 2. Fix watcher-bridge silent failures
- Add `logger.error(...)` in the stream reader catch block (line 81–102)
- Wrap `stdin.flush()` in a try/catch or `.catch()` (line 127)
- These are the only async fire-and-forget paths lacking error visibility

### 3. DB initialization error handling in index.ts
`openDatabase()` is called at top level with no error handling. If the DB file is locked or
corrupted, the agent crashes with an unformatted stack trace. Wrap in try/catch with a
structured error log and graceful exit.

## Out of Scope
- Test coverage expansion (18 uncovered modules — separate epic)
- Rust async I/O fixes (separate spec: fix-rust-async-io)
- Import circular dependency analysis (needs deeper investigation)
