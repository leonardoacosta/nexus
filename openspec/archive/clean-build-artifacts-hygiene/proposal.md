# Proposal: Build Artifact & Hygiene Cleanup

## Change ID
`clean-build-artifacts-hygiene`

## Summary
Address code hygiene findings from the audit: remove `console.warn` in a production component, eliminate `as any` type assertions in tests, and split oversized test files into focused modules.

## Context
- Extends: apps/nextjs/src/components/HealthPoller.tsx, apps/nextjs/src/lib/agent-client.test.ts, apps/agent/src/credentials/credentials.test.ts, apps/agent/src/server.test.ts, apps/agent/src/routes/projects-discovered.test.ts
- Related: audit wave 2 findings; enforce-layering-dry-cleanup (no overlap — that spec covers import layering, not test structure)

## Motivation
The codebase audit flagged several hygiene issues that increase noise and reduce maintainability: a `console.warn` in a client component that should either be silent or use structured logging, `as any` casts that bypass TypeScript's safety in tests, and test files exceeding 500 lines that mix unrelated concerns. Fixing these reduces friction for future contributors and keeps the test suite navigable.

## Requirements

### Req-1: Remove console.warn from HealthPoller
Replace the `console.warn` at HealthPoller.tsx:55 with silent failure (the component already retains stale data on error — the warn adds no operational value in production). If client-side error visibility is desired later, a structured logger can be introduced as a separate spec.

### Req-2: Eliminate `as any` type assertions in agent-client tests
The two `as any` casts at agent-client.test.ts:327,353 access the private `discoveredProjectsMap` field. Fix by either: (a) adding a package-private test helper on `AgentClient` that seeds the map, or (b) creating a `TestAgentClient` subclass that exposes the map for test seeding. Option (b) is preferred to avoid polluting the production API.

### Req-3: Split large test files by concern
Break the four oversized test files into focused modules:
- `credentials.test.ts` (1214 lines) → `credential-crud.test.ts`, `credential-pool.test.ts`, `credential-encryption.test.ts`, `credential-tls.test.ts`, `credential-health.test.ts`
- `server.test.ts` (690 lines) → `server-health.test.ts`, `server-cors.test.ts`, `server-websocket-auth.test.ts`, `server-websocket-lifecycle.test.ts`, `server-ingest.test.ts`
- `agent-client.test.ts` (527 lines) → `agent-client-core.test.ts`, `agent-client-discovery.test.ts`, `agent-client-dedup.test.ts`
- `projects-discovered.test.ts` (523 lines) → `projects-expand.test.ts`, `projects-discovered-core.test.ts`, `projects-discovered-edge.test.ts`

## Scope
- **IN**: console.warn removal, `as any` elimination, test file splitting for the 4 identified files
- **OUT**: Adding a structured client-side logging library, refactoring test logic or assertions, changing test coverage, dist/ gitignore (already resolved — `dist/` is in .gitignore and was never committed)

## Impact
| Area | Change |
|------|--------|
| HealthPoller.tsx | Remove 1 console.warn line |
| agent-client.test.ts | Replace 2 `as any` casts with TestAgentClient subclass |
| agent-client.ts | No change (private field stays private) |
| 4 test files | Split into ~16 focused test modules |

## Risks
| Risk | Mitigation |
|------|-----------|
| Test file splits may break shared setup/fixtures | Extract shared helpers into `*.helpers.ts` files co-located with tests |
| TestAgentClient subclass couples to internal API | Keep subclass in test directory only; document that it mirrors private field |
| Splitting may cause import path changes in CI config | Verify no test config references specific file paths (Bun test uses glob patterns) |
