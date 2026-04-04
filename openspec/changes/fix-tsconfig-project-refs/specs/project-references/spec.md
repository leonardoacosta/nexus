# Spec: TypeScript Project References

## ADDED Requirements

### Requirement: tsconfig.base.json at workspace root

Shared compiler options live in `tsconfig.base.json`. This file MUST NOT contain `rootDir`, `outDir`, `include`, `exclude`, or `files`.

#### Scenario: base config is clean of per-package settings
- **Given** a developer runs `tsc --showConfig` from any package
- **When** the effective config is printed
- **Then** the `rootDir` and `outDir` values come from the package-level tsconfig, not from `tsconfig.base.json`

---

### Requirement: Root tsconfig.json is references-only

The root `tsconfig.json` MUST contain exactly `"files": []` and a `references` array. It MUST NOT contain `compilerOptions`.

#### Scenario: root tsconfig owns zero files
- **Given** the root `tsconfig.json` is in its final state
- **When** `tsc -p tsconfig.json --listFiles` is run from the workspace root
- **Then** no source files are listed (the program is empty)

---

### Requirement: All TypeScript packages declare composite: true

Every package that is listed in the root `references` array MUST have `composite: true` in its own `compilerOptions`. This enables per-package `tsbuildinfo` files and allows cross-package go-to-definition in the LSP.

Packages: `packages/core`, `packages/db`, `packages/ui`, `apps/agent`, `apps/nextjs`, `apps/nexus-register`.

#### Scenario: tsc --build succeeds from workspace root
- **Given** all six packages have `composite: true` and extend `tsconfig.base.json`
- **When** `tsc --build` is run from the workspace root
- **Then** all packages compile without errors and each emits a `.tsbuildinfo` file

#### Scenario: LSP reports no false-positive rootDir errors
- **Given** the language server opens `packages/core/src/types/session.ts`
- **When** the LSP processes the file
- **Then** no "file is not under rootDir" diagnostic is reported

---

### Requirement: apps/nextjs composite + noEmit compatibility

`apps/nextjs` uses `noEmit: true`. TypeScript 5.x allows `composite: true` alongside `noEmit: true`; declaration files are not written when `noEmit` is set. The config MUST retain `noEmit: true` and add `composite: true` without adding a `declarationDir`.

#### Scenario: Next.js app typechecks without declaration write
- **Given** `apps/nextjs/tsconfig.json` has both `composite: true` and `noEmit: true`
- **When** `pnpm typecheck` is run in `apps/nextjs`
- **Then** no declaration files are written and typecheck exits 0

#### Scenario: next module resolves from package node_modules
- **Given** the LSP uses `apps/nextjs/tsconfig.json` as the project root for nextjs files
- **When** `layout.tsx` imports from `"next"`
- **Then** no "Cannot find module 'next'" diagnostic is reported

## MODIFIED Requirements

### Requirement: All package tsconfigs extend tsconfig.base.json

Each of the six package `tsconfig.json` files MUST change `"extends": "../../tsconfig.json"` to `"extends": "../../tsconfig.base.json"`. No other extends change is permitted.

#### Scenario: extends path is correct after change
- **Given** `packages/core/tsconfig.json` is updated
- **When** `cat packages/core/tsconfig.json | jq '.extends'`
- **Then** the output is `"../../tsconfig.base.json"`
