# Proposal: Add AppContext — Centralize Scattered Singleton State

## Change ID
`add-app-context`

## Summary
Replace 20 module-level singleton Maps/Sets with a single AppContext object created at startup and passed to routes and services, making all process state visible, testable, and lifecycle-managed.

## Context
- Extends: `apps/agent/src/index.ts`, `apps/agent/src/server.ts`, all route and service files
- Related: Architecture review (2026-04-09) finding 5

## Motivation
The Bun agent has 20 `new Map()` / `new Set()` declarations scattered across module scope. These singletons are invisible to tests, have no lifecycle management, and some leak memory (dedupMap never resets, seenCanonicalPaths accumulates forever). An AppContext object created at startup provides: (1) single place to see all process state, (2) test isolation (create fresh context per test), (3) graceful cleanup on shutdown, (4) type-safe access to shared dependencies (db, config, services).

## Requirements

### Req-1: AppContext type and factory
Define an `AppContext` interface containing all shared state: db, config, sessionManager, lifecycleBus, commandState (typeOverrides, projectRules), notificationDedup, credentialPool, environmentCache, failureBuffer, commandRegistry. Create a `createAppContext(db, config)` factory.

### Req-2: Migrate routes to context
Update all route handler signatures to accept AppContext. Route handlers currently access module-level singletons; change them to read from `ctx.sessionManager`, `ctx.lifecycleBus`, etc. Update server.ts to create the context and pass it to route registration.

### Req-3: Migrate services to context
Update services (cron, spec-watcher, peer-connector, socket-server) to receive AppContext at startup instead of importing singletons. Services write to context-owned state.

### Req-4: Fix memory leak singletons
As part of the migration, fix the identified leak-risk singletons: `notifications.ts dedupMap` (add TTL or max-size), `projects-discovered.ts seenCanonicalPaths` (clear on refresh cycle), `command-handler.ts typeOverrides/projectRules` (bound to context lifecycle).

## Scope
- **IN**: AppContext type, factory, migration of all routes and services, memory leak fixes
- **OUT**: Changing API contracts, adding new features, modifying the lifecycle bus event types

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/context.ts` | New file: AppContext interface + createAppContext factory |
| `apps/agent/src/index.ts` | Create context at startup, pass to server and services |
| `apps/agent/src/server.ts` | Accept context, pass to route handlers |
| `apps/agent/src/routes/*.ts` | All handlers accept context parameter |
| `apps/agent/src/services/*.ts` | All services accept context at startup |
| Net | ~200 LOC new, ~100 LOC removed (singleton declarations) |

## Risks
| Risk | Mitigation |
|------|-----------|
| Large refactor touching every file | Mechanical change — find/replace singleton imports with context access |
| Breaking existing tests that import singletons directly | Update test helpers to create mock context |
| Circular dependency if context imports from services that import context | Context only defines types + factory; services receive context, never import it |
