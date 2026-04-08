# Spec Delta: TS Codegen Pipeline

## ADDED Requirements

### Requirement: TypeScript Types Generated from Proto
A codegen pipeline MUST produce TypeScript interfaces from `proto/nexus.proto`. Generated types SHALL replace hand-written interfaces in `packages/core/src/types/`.

#### Scenario: Running proto:codegen produces up-to-date TS files
- **Given** `proto/nexus.proto` has been modified
- **When** `pnpm proto:codegen` is run from the workspace root
- **Then** generated TS files in `packages/core/src/generated/` reflect the proto changes

#### Scenario: CI verifies generated files are fresh
- **Given** a PR that modifies `proto/nexus.proto` without regenerating TS
- **When** CI runs `pnpm proto:codegen --check`
- **Then** the check fails with a diff showing stale generated files

### Requirement: Generated Types Replace Hand-Written Interfaces
`packages/core/src/types/session.ts` and `packages/core/src/types/health.ts` MUST be replaced by re-exports from generated code. Downstream consumers (dashboard, agent) SHALL import from the same paths with no changes.

#### Scenario: Session type import unchanged for consumers
- **Given** a consumer file that imports `Session` from `@nexus/core`
- **When** the codegen replacement is applied
- **Then** the import continues to resolve and the `Session` type includes `machine` and `endedAt` fields

#### Scenario: HealthMetrics type includes all proto fields
- **Given** generated TS types from the restructured proto `MachineHealth`
- **When** `HealthMetrics` is inspected in the generated output
- **Then** it includes nested `cpu`, `ram`, `disk[]`, `docker`, `network`, `processes`, `hostname`, and `collectedAt`
