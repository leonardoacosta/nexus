# audit-scan-rules Specification

## ADDED Requirements

### Requirement: B2 rule recognizes public barrel imports

The B2 rule (architecture / package boundary violation) SHALL differentiate between bare-package imports (e.g., `@nexus/db`) and deep imports that reach into a package's internals (e.g., `@nexus/db/src/schema/sessions`). Only the latter SHALL be flagged.

#### Scenario: Bare barrel import is not flagged

- **GIVEN** an application file contains `import { Session, getSessionsByAgent } from '@nexus/db'`
- **WHEN** audit-scan runs
- **THEN** the scan SHALL NOT emit a B2 finding for that file

#### Scenario: Deep import is still flagged

- **GIVEN** an application file contains `import { sessionsTable } from '@nexus/db/src/schema/sessions'`
- **WHEN** audit-scan runs
- **THEN** the scan SHALL emit a B2 finding pointing to the deep-import line
- **AND** the message SHALL clarify that the import reaches past the public barrel

#### Scenario: Packages-to-apps direction still flagged

- **GIVEN** a file under `packages/core` imports from `apps/agent/...`
- **WHEN** audit-scan runs
- **THEN** the scan SHALL emit a B2 finding — wrong dependency direction is unchanged by this rule refinement

### Requirement: A9 rule distinguishes explicit void markers

The A9 rule (quality / unhandled rejection) SHALL recognize the TypeScript `void` unary operator as an explicit fire-and-forget marker and NOT flag expressions prefixed with it. The rule SHALL continue to flag `.then(...)` chains lacking a `.catch(...)` and bare async calls whose returned Promise is neither awaited nor discarded via `void`.

#### Scenario: void-prefixed call is not flagged

- **GIVEN** a source file contains `void someAsyncFn();` on a line
- **WHEN** audit-scan runs
- **THEN** the scan SHALL NOT emit an A9 finding for that line

#### Scenario: .then without .catch is still flagged

- **GIVEN** a source file contains `somePromise.then(handleResult);` with no `.catch`
- **WHEN** audit-scan runs
- **THEN** the scan SHALL emit an A9 finding for that line

#### Scenario: Bare async call with ignored return is still flagged

- **GIVEN** a source file contains `someAsyncFn();` at statement level (no `await`, no `void`, no `.then`)
- **WHEN** audit-scan runs
- **THEN** the scan SHALL emit an A9 finding for that line

### Requirement: Rule-fix regression coverage

The audit-scan tooling SHALL have automated coverage for both fixes: at least one positive and one negative case per rule, runnable as part of an existing test suite (not a new ad-hoc script).

#### Scenario: Integration test asserts B2 count is zero on nx repo

- **GIVEN** the `fix-audit-scan-rules` change is applied
- **WHEN** the `audit-suppressions.integration.test.ts` suite runs against the nx repo
- **THEN** a test SHALL assert the B2 finding count is zero for all files whose `@nexus/*` imports resolve to bare-package paths

#### Scenario: Integration test asserts A9 count matches refined baseline

- **GIVEN** the `fix-audit-scan-rules` change is applied
- **WHEN** the integration test suite runs against the nx repo
- **THEN** a test SHALL assert the A9 finding count is the documented post-fix baseline (expected: 3, matching the real unhandled-rejection sites in `CommandPalette.tsx`, `session-manager.ts`, and `watcher-bridge.ts`)
