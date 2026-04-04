## 1. Vitest Migration — agent-client.test.ts
- [ ] [1.1] Replace `import { describe, test, expect, mock, beforeEach } from "bun:test"` with `import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"` [owner:engineer]
- [ ] [1.2] Remove `type FetchFn = typeof globalThis.fetch` and the `originalFetch` / `restoreFetch()` pattern [owner:engineer]
- [ ] [1.3] Replace all 9 `globalThis.fetch = mock(async ...) as unknown as FetchFn` assignments with `vi.stubGlobal("fetch", async ...)` — this eliminates all double-casts [owner:engineer]
- [ ] [1.4] Add `afterEach(() => vi.restoreAllMocks())` to replace the manual `restoreFetch()` calls in each test [owner:engineer]
- [ ] [1.5] Verify `pnpm typecheck` passes with no remaining `as unknown as` in agent-client.test.ts [owner:engineer]
- [ ] [1.6] Verify `pnpm test` in apps/nextjs runs agent-client tests under vitest [owner:engineer]

## 2. Watcher Bridge Error Handling
- [ ] [2.1] Add error logging in the catch block of the async IIFE stream reader (watcher-bridge.ts line ~101): `catch (err) { logger.error("watcher stdout stream closed", { error: err }); }` [owner:engineer]
- [ ] [2.2] Wrap `stdin.flush()` call (watcher-bridge.ts line ~127) in try/catch with `logger.warn("watcher stdin flush failed", ...)` on error [owner:engineer]

## 3. DB Initialization Error Handling
- [ ] [3.1] Wrap `openDatabase()` call in apps/agent/src/index.ts in try/catch; on failure log a structured error and `process.exit(1)` [owner:engineer]

## 4. Verification
- [ ] [4.1] Run `pnpm typecheck` in apps/nextjs — confirm zero type errors [owner:engineer]
- [ ] [4.2] Run `pnpm test` in apps/nextjs — confirm agent-client tests pass under vitest [owner:engineer]
- [ ] [4.3] Run `pnpm test` in apps/agent — confirm watcher-bridge still builds and agent tests pass [owner:engineer]
