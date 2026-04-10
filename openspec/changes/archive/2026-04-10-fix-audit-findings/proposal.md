# Proposal: Fix Audit Findings

## Change ID
`fix-audit-findings`

## Summary
Address all 257 findings from the 2026-04-09 code audit (excluding D4 exec/spawn — intentional for tmux harness management). Delete 9,200 lines of dead code, refactor the server.ts god-module, remove the half-finished AppContext abstraction, add fetch timeouts, fix SQL interpolation, migrate timestamps to date mode, and fill .env.example gaps.

## Context
- Extends: `apps/agent/src/server.ts`, `apps/agent/src/context.ts`, `packages/db/src/schema/*`, `packages/core/src/generated/`, `crates/*`
- Related: Wave 3 introduced AppContext but never wired it. Prior audits (Wave 1-3) scored 72-75/100.
- Audit report: `docs/diagrams/code-audit-2026-04-09.html`

## Motivation
The codebase scores 78/100 (B) with Architecture at 68 — the weakest axis. 35% of the codebase (9,200 lines) is dead code that cannot compile or has zero consumers. The 1,082-line server.ts god-module is the primary instability hotspot — every new route adds boilerplate and churn. Half-finished abstractions (AppContext, DedupMap duplication) create confusion without benefit. This spec consolidates all audit findings into one cleanup pass to raise maintainability for a solo developer.

## Requirements

### Requirement: Delete dead code
Remove all code identified as dead by the audit:
- `crates/nexus-register/` (92 LOC Rust — uses gRPC, no server exists)
- `crates/nexus-mcp/` (649 LOC Rust — no Cargo workspace, cannot compile)
- `crates/archive/` (empty directory)
- `packages/core/src/generated/` (7,733 LOC protobuf, zero consumers)
- `proto/` directory and `proto:codegen` script from root package.json
- `ProtoSession` and `ProtoMachineHealth` re-exports from `packages/core/src/types/`

Note: `crates/nexus-status/` (619 LOC Rust) is deployed — replace with Bun equivalent before deleting.

### Requirement: Replace nexus-status with Bun implementation
Write a ~100 LOC Bun replacement for `crates/nexus-status/src/main.rs` that:
- Fetches session summary from the agent HTTP API
- Fetches API usage/credit info
- Renders a compact statusline string for Claude Code prompt
- Passes `NEXUS_ATTACH_SECRET` header (fixes the auth bypass security finding)
- Installs as `nexus-status` binary

### Requirement: Refactor server.ts route dispatch
Replace the 440-line if/else chain in `createRequestHandler` (lines 282-874) with a declarative route table pattern:
- Define routes as data: `{ method, path, handler, requiresDb? }`
- Single `withErrorHandler` wrapper replaces ~30 duplicated `.catch()` blocks
- Extract WebSocket lifecycle (`ServerState`, ping/pong, federation) into `server-websocket.ts`
- Remove duplicate credential ID pre-validation (lines 407-429 — redundant with route-level checks)
- Target: server.ts drops from 1,082 to ~300 lines

### Requirement: Delete AppContext abstraction
Remove the half-finished AppContext introduced in Wave 3:
- Delete `apps/agent/src/context.ts` (DedupMap, BoundedMap, CommandState, AppContext)
- Delete `apps/agent/src/context.test.ts`
- Remove `ctx?: AppContext` parameter from `startServer()` and `createRequestHandler()`
- Remove AppContext creation from `apps/agent/src/index.ts`
- Remove duplicate `ProjectRules` interface from `apps/agent/src/services/command-handler.ts:43-48`
- Keep module-level singletons as the canonical state pattern

### Requirement: Add fetch timeout utility
Create a shared `fetchWithTimeout` utility to fix 64 E7 findings:
- Wraps `fetch()` with `AbortController` and configurable timeout (default 10s)
- Replace all bare `fetch()` calls in `apps/agent/` and `apps/nextjs/` with `fetchWithTimeout()`
- Export from `packages/core` for cross-app use

### Requirement: Fix SQL interpolation in credential pool
Fix 4 C5 findings — SQL template literals with direct interpolation:
- `apps/agent/src/credentials/pool.ts` lines 115, 230, 332, 333
- Replace string interpolation with `sql.placeholder()` or parameterized queries
- Batch the N+1 credential cleanup (C1) while touching this file: replace SELECT + N UPDATEs with single `inArray()` batch UPDATE

### Requirement: Migrate timestamp columns to date mode
Fix 17 C3 findings — timestamp columns using `mode: "string"` instead of `mode: "date"`:
- Update all timestamp column definitions in `packages/db/src/schema/` to use `mode: "date"`
- Update all code that handles these timestamps as strings to work with Date objects
- Generate and apply Drizzle migration

### Requirement: Fix unhandled promise rejections
Fix 27 A9 findings — `.then()` without `.catch()`:
- Add `.catch()` handlers or convert to `async/await` with try/catch
- Focus on `apps/nextjs/src/components/CommandPalette.tsx`, `LazyTerminalPanel.tsx`, and `apps/agent/src/server.ts`
- Remaining instances across 7 files

### Requirement: Fix cross-boundary imports in Next.js
Fix 8 B2 findings — UI importing from internal db/api paths:
- `apps/nextjs/src/lib/db.ts` lines 1-2
- `apps/nextjs/src/lib/get-client.ts` line 4
- Plus 5 more across 5 files
- Route all DB access through the `@nexus/db` public barrel or create proper API endpoints

### Requirement: Fill .env.example gaps
Fix 14 H1 findings — env vars used in source but missing from `.env.example`:
- Add all 14 missing env vars (CLAUDE_SESSION_ID, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, etc.)
- Include descriptions and example values

### Requirement: Fix module-level singleton side-effect
Fix the import-time side-effect in `apps/agent/src/server.ts:265-277`:
- Defer `ServerState.create()`, `HealthCollector.start()`, and `StreamManager` instantiation to `startServer()` call
- Remove `_singletonState` backward-compat pattern

### Requirement: Remove sync I/O in hot paths
Fix 20 E5 findings — `readFileSync`, `writeFileSync`, `execSync` in non-test code:
- Replace with async variants (`readFile`, `writeFile`)
- Test files are excluded (sync I/O acceptable in tests)

## Scope
- **IN**: All audit findings except D4 (exec/spawn intentional for tmux). Includes dead code deletion, router refactor, AppContext removal, fetch timeouts, SQL fixes, timestamp migration, promise fixes, cross-boundary imports, .env.example, singleton side-effect, sync I/O.
- **OUT**: D4 exec/spawn findings (intentional), test file restructuring, performance optimizations beyond fetch timeouts and sync I/O, Drizzle relations() additions (C10), soft-delete columns (C11), PostHog integration (F5), healthcheck endpoint for Next.js (F8), npm_package_version naming (G10).

## Impact
| Area | Change |
|------|--------|
| crates/ | Delete nexus-register, nexus-mcp, archive. Replace nexus-status with Bun. |
| packages/core | Delete 7.7K generated protobuf. Add fetchWithTimeout utility. |
| packages/db | Migrate 17 timestamp columns to date mode. |
| apps/agent/server.ts | Route table refactor (-700 LOC). Remove singleton side-effect. |
| apps/agent/context.ts | Delete entirely (-300 LOC). |
| apps/agent/credentials/pool.ts | Fix SQL interpolation, batch N+1 queries. |
| apps/nextjs | Fix cross-boundary imports, add .catch() to promises. |
| .env.example | Add 14 missing env vars. |

## Risks
| Risk | Mitigation |
|------|-----------|
| Timestamp migration breaks string-handling code | Grep all timestamp field consumers, update to Date API before migration |
| Route table refactor breaks existing tests | server.test.ts covers all routes — run after each batch of route migrations |
| nexus-status Bun replacement misses edge cases | Port test cases from Rust; verify statusline output matches |
| Cross-boundary import fix may need new API surface | Check if @nexus/db barrel already exports needed queries |
