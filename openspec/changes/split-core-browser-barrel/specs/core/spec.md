## MODIFIED Requirements

### Requirement: Package exports
The `@nexus/core` package SHALL expose two distinct entry points: a browser-safe default barrel and a node-only `./node` subpath. The default entry (`@nexus/core`) SHALL only export symbols whose transitive imports are safe in a browser environment — types, zod schemas, and string constants. The `@nexus/core/node` subpath SHALL export node-runtime helpers (`safeSpawn`, `expandTilde`, `parseConfig`, `logger`, `createLogger`, and the config/spawn schemas and error types). The pre-existing `@nexus/core/fetch` subpath SHALL remain unchanged.

#### Scenario: Browser code imports types
- **GIVEN** a `"use client"` component in `apps/nextjs/`
- **WHEN** it imports any symbol from `@nexus/core` (e.g., `SpecTransitionEvent`, `specEventsFrameSchema`)
- **THEN** the resulting webpack bundle MUST NOT contain references to `node:os`, `node:path`, `node:fs`, or `child_process`
- **AND** `next build` MUST succeed without "Module not found" errors

#### Scenario: Agent code imports node helpers
- **GIVEN** a Bun runtime file in `apps/agent/`
- **WHEN** it needs `safeSpawn`, `parseConfig`, `expandTilde`, `logger`, `createLogger`, or any of the moved schemas/error types
- **THEN** it MUST import from `@nexus/core/node`, not from `@nexus/core`
- **AND** `tsc --noEmit` MUST succeed across the workspace

#### Scenario: Browser barrel rejects node imports
- **GIVEN** a contributor edits `packages/core/src/index.ts` to re-export from `./safe-spawn`, `./config`, `./logger`, `./path`, or `./node`
- **WHEN** the lint step runs (`pnpm lint` or `eslint .` in `packages/core`)
- **THEN** the lint MUST fail with a `no-restricted-imports` violation pointing at the offending line

### Requirement: Type definitions remain canonical
All types and schemas exported by `@nexus/core` SHALL have exactly one source-of-truth definition in `packages/core/src/types/`. No file in `apps/nextjs/`, `apps/agent/`, or any other workspace package SHALL contain a duplicate or hand-rewritten copy of a type that `@nexus/core` already exports.

#### Scenario: spec-events-subscriber uses the canonical type
- **GIVEN** `apps/nextjs/src/app/specs/spec-events-subscriber.tsx`
- **WHEN** the file references `SpecTransitionEvent` or `SpecEventsFrame`
- **THEN** the type MUST be imported from `@nexus/core` (not redeclared inline)
- **AND** the file MUST NOT contain a "Keep this in sync with the core source of truth" comment or any equivalent manual-sync marker

#### Scenario: Audit catches future duplicates
- **GIVEN** any `.ts` or `.tsx` file in `apps/`
- **WHEN** a grep for `type SpecTransitionEvent`, `interface SpecEventsFrame`, or any other type name exported by `@nexus/core` runs against `apps/`
- **THEN** zero results MUST be returned (the only declaration site is `packages/core/src/types/`)
