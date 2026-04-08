# Implementation Tasks

<!-- beads:epic:nx-mwip -->

## Utility Batch

- [x] [1.1] [P-1] Create `apps/agent/src/utils/safe-fire-and-forget.ts` — export `safeFireAndForget(promise: Promise<unknown>, context: string): void` that attaches `.catch()` logging via `@nexus/core` logger [owner:agent-engineer] [beads:nx-tyab]
- [x] [1.2] [P-1] Add unit test for `safeFireAndForget()` — verify resolved promises are silent, rejected promises log warning with context, no unhandled rejection emitted [owner:agent-engineer] [beads:nx-3e16]

## Server Batch

- [x] [2.1] [P-1] Add `.catch()` to all 15 `.then()` chains in `server.ts` `createRequestHandler()` (lines 369-528) — each `.catch()` logs `{ route, method, error }` and returns CORS-wrapped 500 JSON response [owner:agent-engineer] [beads:nx-jmlp]
- [x] [2.2] [P-2] Replace `void initNotificationRoutes(db)` at server.ts:556 with `safeFireAndForget(initNotificationRoutes(db), "init-notification-routes")` [owner:agent-engineer] [beads:nx-jqkf]

## Agent Fire-and-Forget Batch

- [x] [3.1] [P-1] Replace bare `void this.tick()` in `health-collector.ts` (lines 28-29) with `safeFireAndForget(this.tick(), "health-collector-tick")` [owner:agent-engineer] [beads:nx-1dvh]
- [x] [3.2] [P-1] Replace bare `void this.tick()` in `health-scheduler.ts` (lines 30-31) with `safeFireAndForget(this.tick(), "health-scheduler-tick")` [owner:agent-engineer] [beads:nx-diui]
- [x] [3.3] [P-1] Replace bare `void` patterns in `watcher-bridge.ts` (lines 117, 140, 160) with `safeFireAndForget()` — note: line 140 (`stdin.flush()`) returns `number | Promise<number>`, so handled with inline `.catch()` on the result if it is a Promise, plus existing try/catch for synchronous throws [owner:agent-engineer] [beads:nx-rdg0]
- [x] [3.4] [P-1] Replace bare `void runRetentionCleanup(db)` in `retention.ts` (lines 40, 43) with `safeFireAndForget(runRetentionCleanup(db), "retention-cleanup")` [owner:agent-engineer] [beads:nx-k6qf]

## Next.js Batch

- [x] [4.1] [P-2] Add `.catch()` to `fetchSessions().then()` in `CommandPalette.tsx` (line 131) — log error to console, optionally set an error state for user feedback [owner:ui-engineer] [beads:nx-cjhm]
- [x] [4.2] [P-2] Evaluate `LazyTerminalPanel.tsx` dynamic import `.then()` (line 6) — Next.js `dynamic()` handles import errors via its internal error boundary; the `.then()` is just a named export extractor. Documented as acceptable — no change needed. [owner:ui-engineer] [beads:nx-18wg]

## Verification Batch

- [ ] [5.1] Run `bun test` for agent to verify no regressions [owner:agent-engineer] [beads:nx-n9ul]
- [ ] [5.2] Run `pnpm build` for nextjs app to verify no type errors from changes [owner:ui-engineer] [beads:nx-a41r]
- [ ] [5.3] Grep codebase for remaining bare `void <async>` patterns in `apps/agent/src/` — confirm zero unprotected instances remain [owner:agent-engineer] [beads:nx-z286]
