# Proposal: Split @nexus/core into browser-safe and node-only entries

## Change ID
`split-core-browser-barrel`

## Summary
Split `@nexus/core` barrel so client code can import types and zod schemas without pulling node:os / node:path through `safeSpawn`, `expandTilde`, `parseConfig`. Establish `@nexus/core` (browser-safe) + `@nexus/core/node` (node-only) entries; delete the duplicated SpecTransitionEvent/SpecEventsFrame in spec-events-subscriber.tsx.

## Context
- Extends: `packages/core/src/index.ts` (current barrel, 73 lines), `packages/core/package.json` (exports field — currently exposes `.` and `./fetch`, no `./node` subpath)
- Related: `openspec/changes/archive/2026-04-17-split-b4-large-files/` (split-by-concern pattern), commit `6a4be9e` (the workaround we're undoing)
- Audit findings: C3-arch (error) and B10 (warning) from the 2026-04-17 audit wave

## Motivation
The `@nexus/core` barrel currently re-exports two incompatible groups of symbols from a single entry point:

1. **Browser-safe** (lines 1-40 of `index.ts`): pure types and zod schemas — `Session`, `HealthMetrics`, `SpecTransitionEvent`, `specEventsFrameSchema`, etc. Safe to import in `"use client"` components.
2. **Node-only** (lines 41-72): `safeSpawn`, `expandTilde`, `parseConfig`, `logger` — these transitively import `node:os`, `node:path`, `node:fs`, and `child_process`.

When a Next.js client component imports anything from `@nexus/core`, webpack's static analysis follows the barrel and tries to bundle the node-only modules. This **breaks the production build** (`next build` fails with "Module not found: Can't resolve 'node:os'") even when the client code only references browser-safe symbols. Tree-shaking does not save us — the breakage happens at module-resolution time, before tree-shaking runs.

The most recent occurrence (commit `6a4be9e`, 2026-04-17) was "fixed" by **manually duplicating** `SpecTransitionEvent` and `SpecEventsFrame` types into `apps/nextjs/src/app/specs/spec-events-subscriber.tsx:25-48`, with a comment that reads "Keep this in sync with the core source of truth." This is institutionalized type drift — the next time a contributor adds a "use client" file that imports from `@nexus/core` and forgets to duplicate, the production build will silently break again. The drift between the duplicate and the source has zero compile-time enforcement.

The clean fix is to split the barrel: keep `@nexus/core` as the browser-safe entry (types + zod schemas + the existing `./fetch` subpath), and move all node-only exports to a new `@nexus/core/node` subpath. Browser code imports from `@nexus/core`; agent/server code that needs `safeSpawn` or `parseConfig` imports from `@nexus/core/node`. The duplicate in `spec-events-subscriber.tsx` then deletes itself — once the barrel is safe, the original import works again.

## Requirements

### Requirement: Browser-safe barrel
The default entry `@nexus/core` (`packages/core/src/index.ts`) SHALL only re-export symbols that are safe to evaluate in a browser environment. Concretely: types from `./types/*`, zod schemas (`specEventsFrameSchema`, `credentialsActiveResponseSchema`), and string constants (`SPEC_EVENTS_EVENT_NAME`). The barrel SHALL NOT directly or transitively import `node:os`, `node:path`, `node:fs`, `node:child_process`, or any module that does (e.g., `pino` with file transports, `smol-toml`).

### Requirement: Node-only entry point
The package SHALL expose a new subpath export `@nexus/core/node` (mapped to a new `packages/core/src/node.ts` file) that re-exports the symbols currently in `index.ts:41-72`: `safeSpawn`, `isSafeArg`, `assertAllowedBinary`, `ALLOWED_BINARIES`, `DisallowedBinaryError`, `UnsafeArgError`, `expandTilde`, `parseConfig`, `AgentConfigSchema`, `NexusConfigSchema`, `getAgentId`, `getAgentsConfigPath`, `resetAgentIdCache`, `logger`, `createLogger`, plus the related types (`AllowedBinary`, `SafeSpawnHandle`, `SafeSpawnOptions`, `StdioMode`, `AgentConfig`, `NexusConfig`, `ConfigError`, `ConfigResult`, `Logger`). The existing `@nexus/core/fetch` subpath SHALL remain unchanged.

### Requirement: Delete duplicated types
The manually duplicated `SpecTransitionEvent` and `SpecEventsFrame` type declarations in `apps/nextjs/src/app/specs/spec-events-subscriber.tsx:25-48` (added in commit `6a4be9e` as a workaround) SHALL be removed. The file SHALL import these types from `@nexus/core` directly. The "Keep this in sync with the core source of truth" comment SHALL also be removed. No other duplicate type declarations of `@nexus/core` symbols SHALL exist in `apps/nextjs/`.

### Requirement: Migration of existing imports
All call sites in `apps/agent/` (and any other workspace package) that currently import the moved symbols (`safeSpawn`, `expandTilde`, `parseConfig`, `logger`, `createLogger`, `AgentConfig`, `NexusConfig`, etc.) from `@nexus/core` SHALL be updated to import from `@nexus/core/node`. A `tsc --noEmit` pass across the workspace SHALL succeed after the migration. A grep audit SHALL confirm zero remaining imports of moved symbols from the bare `@nexus/core` specifier.

## Scope
- **IN**: Split `packages/core/src/index.ts` barrel; add `./node` export to `packages/core/package.json`; create `packages/core/src/node.ts`; update `apps/agent/` imports; delete `spec-events-subscriber.tsx` duplicates; add ESLint guard against re-introduction
- **OUT**: Refactoring node modules themselves (`safe-spawn.ts`, `config.ts`, `logger.ts`, `path.ts` stay byte-identical); changing zod schemas; changing public type shapes; touching the existing `./fetch` subpath; renaming the package

## Impact

| Area | Change |
|------|--------|
| `packages/core` | Barrel split into `index.ts` (browser-safe) + new `node.ts` (node-only); package.json gains `./node` subpath export |
| `apps/agent` | ~10 import paths updated from `@nexus/core` → `@nexus/core/node` for moved symbols |
| `apps/nextjs` | `spec-events-subscriber.tsx:25-48` duplicates removed; imports `SpecTransitionEvent`/`SpecEventsFrame` from `@nexus/core` |
| ESLint config | New `no-restricted-imports` rule preventing the browser barrel from re-importing `./node` paths |

## Risks

| Risk | Mitigation |
|------|-----------|
| Missed import site → runtime `ReferenceError` in agent | `tsc --noEmit` workspace-wide + `grep -r "from \"@nexus/core\"" apps/agent` audit before merge |
| Node module accidentally re-imported into browser barrel later | ESLint `no-restricted-imports` rule banning `./node` paths from `index.ts` |
| Bundler still resolves `node:*` due to incidental import in a `./types/*` file | Unit test that imports the browser barrel and asserts the resolved dep graph contains no `node:` builtins |
| Downstream `apps/nextjs` consumers blow up on dev server during the migration | Land in single PR with all import-site updates so there's no intermediate broken state |
