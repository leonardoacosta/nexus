# Proposal: Agent Promise Error Handling

## Change ID
`fix-agent-promise-errors`

## Summary
Add `.catch()` handlers to 15 unhandled `.then()` chains in server.ts, create a `safeFireAndForget()` utility for intentional fire-and-forget patterns across 5 agent files, and fix 2 Next.js component promise handling issues.

## Context
- Extends: `apps/agent/src/server.ts`, `apps/agent/src/health-collector.ts`, `apps/agent/src/health-scheduler.ts`, `apps/agent/src/watcher-bridge.ts`, `apps/agent/src/db/retention.ts`, `apps/nextjs/src/components/CommandPalette.tsx`, `apps/nextjs/src/components/LazyTerminalPanel.tsx`
- Related: `async-safety` spec (Rust-side blocking — no overlap, that covers reqwest/signals/docker; this covers Bun/TS promise chains)

## Motivation
Unhandled promise rejections in the Bun agent can crash the process or silently swallow errors that should be logged. The 15 `.then()` calls in server.ts route handlers will produce unhandled rejections if any handler throws. Fire-and-forget `void` patterns in health-collector, health-scheduler, watcher-bridge, and retention.ts silently discard errors from async ticks and cleanup routines. On the Next.js side, a missing `.catch()` in CommandPalette means fetch failures are invisible to users and developers.

## Requirements

### Req-1: Server Route Handler Error Safety
All `.then()` chains in `server.ts` route handlers must have `.catch()` handlers that log the error and return a 500 response, preventing unhandled promise rejections from crashing the Bun process.

### Req-2: Safe Fire-and-Forget Utility
A `safeFireAndForget()` utility function must exist that wraps a Promise, catches any rejection, and logs the error via the `@nexus/core` logger. All intentional fire-and-forget patterns across the agent codebase must use this utility instead of bare `void`.

### Req-3: Next.js Component Promise Handling
Promise chains in React components must have `.catch()` handlers or use `try/catch` with `await` to prevent silent failures and provide user-visible error feedback where appropriate.

## Scope
- **IN**: Adding `.catch()` to 15 server.ts `.then()` chains, creating `safeFireAndForget()` utility, replacing bare `void` fire-and-forget in health-collector (2), health-scheduler (2), watcher-bridge (3), retention.ts (2), server.ts (1), fixing CommandPalette.tsx promise handling, fixing LazyTerminalPanel.tsx dynamic import error handling
- **OUT**: Splitting server.ts into smaller modules (noted as separate concern, ~696 lines), Rust-side async safety (covered by existing `async-safety` spec), refactoring route handlers to `async/await` style (improvement but separate scope)

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/server.ts` | Add `.catch()` to 15 `.then()` chains, replace 1 `void` with `safeFireAndForget()` |
| `apps/agent/src/utils/safe-fire-and-forget.ts` | New utility file (~15 lines) |
| `apps/agent/src/health-collector.ts` | Replace 2 bare `void` with `safeFireAndForget()` |
| `apps/agent/src/health-scheduler.ts` | Replace 2 bare `void` with `safeFireAndForget()` |
| `apps/agent/src/watcher-bridge.ts` | Replace 3 bare `void` with `safeFireAndForget()` |
| `apps/agent/src/db/retention.ts` | Replace 2 bare `void` with `safeFireAndForget()` |
| `apps/nextjs/src/components/CommandPalette.tsx` | Add `.catch()` to `fetchSessions().then()` |
| `apps/nextjs/src/components/LazyTerminalPanel.tsx` | Add error handling to dynamic import `.then()` |

## Risks
| Risk | Mitigation |
|------|-----------|
| `.catch()` handlers mask real bugs by only logging | Include structured context (route, method, sessionId) in error logs so issues are diagnosable |
| `safeFireAndForget()` encourages more fire-and-forget patterns | Document in utility JSDoc that callers should prefer `await` when possible; utility is for genuinely fire-and-forget scenarios only |
| Changing `void` to `safeFireAndForget()` subtly changes timing | `safeFireAndForget()` is a thin wrapper that does not change execution order — it only adds a `.catch()` |
