# audit-scan-rules Specification

## Purpose
TBD - created by archiving change fix-audit-scan-rules. Update Purpose after archive.
## Requirements
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

### Requirement: A9 recognizes chain-terminal catch beyond 4-line window

The A9 rule SHALL detect `.catch(` anywhere within the enclosing Promise chain, not just within the next 4 lines after a flagged `.then(`. The rule's lookahead SHALL extend until the chain terminates (e.g., a `;`, a `)` closing the chain expression, or a newline not continuing the chain).

#### Scenario: Long chain with terminal catch is not flagged

- **GIVEN** a source file contains `p.then(A).then(B).then(C).catch(D);` split across multiple lines (say the chain spans 8 lines)
- **WHEN** audit-scan runs
- **THEN** no A9 finding SHALL be emitted for any of the `.then(...)` calls in that chain

#### Scenario: Separate chains still flag independently

- **GIVEN** a source file contains `p.then(A); q.then(B);` on adjacent lines (two distinct chains, neither has `.catch`)
- **WHEN** audit-scan runs
- **THEN** an A9 finding SHALL be emitted for both `.then(...)` calls

### Requirement: A9 recognizes safeFireAndForget wrapper

The A9 rule SHALL recognize `safeFireAndForget(promise, ...)` (identifier match on the exact name) as an implicit catch-equivalent. Any `.then(...)` chain passed as an argument to `safeFireAndForget(...)` SHALL NOT produce an A9 finding.

#### Scenario: safeFireAndForget-wrapped promise is not flagged

- **GIVEN** a source file contains `safeFireAndForget(somePromise.then(handleIt), "context");`
- **WHEN** audit-scan runs
- **THEN** no A9 finding SHALL be emitted for the `.then(handleIt)` call

#### Scenario: Other fire-and-forget wrappers are not recognized

- **GIVEN** a source file contains `myFireAndForget(p.then(handleIt));` — different wrapper name
- **WHEN** audit-scan runs
- **THEN** an A9 finding SHALL be emitted unless a `.catch` is in scope
- **AND** consumers of other wrappers SHALL use suppression config to opt in

### Requirement: E7 skips Bun.serve fetch method-shorthand

The E7 rule SHALL distinguish an object-method-shorthand `fetch(req, ...)` (property definition inside `Bun.serve({ ... })` or similar) from an invoked `fetch(url, ...)` function call. The shorthand form SHALL NOT produce an E7 finding.

#### Scenario: Bun.serve method shorthand is not flagged

- **GIVEN** a source file contains:
  ```ts
  const server = Bun.serve({
    port,
    fetch(req, server) { return handler(req); },
  });
  ```
- **WHEN** audit-scan runs
- **THEN** no E7 finding SHALL be emitted for the `fetch(req, server)` line

#### Scenario: Real fetch call is still flagged

- **GIVEN** a source file contains `const res = fetch("https://api.example.com");` without AbortController
- **WHEN** audit-scan runs
- **THEN** an E7 finding SHALL be emitted for that line

#### Scenario: Method shorthand with different first-arg name is treated as a call (conservative)

- **GIVEN** a source file contains `const cfg = { fetch(url) { return realFetch(url); } };` — shorthand but first arg is `url`, not `req`/`request`
- **WHEN** audit-scan runs
- **THEN** the rule MAY emit an E7 finding (detection is conservative; rule only skips when first-arg name is `req` or `request`)
- **AND** consumers SHALL use a narrow suppression if the shorthand uses non-conventional names

### Requirement: Stale suppressions removed alongside rule fixes

When this change is applied, the `.audit-suppressions.json` entries that exist ONLY to paper over the two rule gaps above SHALL be removed: the A9 entry covering `session-manager.ts`, `watcher-bridge.ts`, and `CommandPalette.tsx`, AND the E7 entry for `apps/agent/src/server.ts`. Unrelated A9 or E7 entries SHALL be preserved.

#### Scenario: Audit scan after suppression removal still reports zero

- **GIVEN** the rule patches are applied AND the stale suppressions are removed
- **WHEN** audit-scan runs against the nx repo
- **THEN** A9 count SHALL be 0 AND E7 count SHALL be 0
- **AND** the 2 removed suppression entries SHALL no longer appear in `.audit-suppressions.json`
- **AND** the CI lint (`scripts/validate-audit-suppressions.sh`) SHALL still pass

### Requirement: A12 requires code-syntax signal to flag commented-out code
The A12 rule SHALL flag a comment only when the same line contains at least one code-syntax signal: `=` (assignment), `()` (call parens), `;` (statement terminator), or `{` (block opener). A comment that begins with a keyword but contains only natural-language text SHALL NOT be flagged.

#### Scenario: Commented-out variable declaration is flagged
- **GIVEN** a source file contains `// const x = 1;` (has `=` and `;`)
- **WHEN** audit-scan runs
- **THEN** an A12 finding SHALL be emitted for that line

#### Scenario: Commented-out function call is flagged
- **GIVEN** a source file contains `// handleClick();` (has `()` and `;`)
- **WHEN** audit-scan runs
- **THEN** an A12 finding SHALL be emitted for that line

#### Scenario: Commented-out return statement is flagged
- **GIVEN** a source file contains `// return result;`
- **WHEN** audit-scan runs
- **THEN** an A12 finding SHALL be emitted for that line

#### Scenario: English prose with no code syntax is NOT flagged
- **GIVEN** a source file contains `// return \`undefined\` so the chain short-circuits gracefully without`
- **WHEN** audit-scan runs
- **THEN** no A12 finding SHALL be emitted for that line

#### Scenario: Edge-case English prose containing parens is handled by comment rephrase
- **GIVEN** a source file originally contained `// if it needs to send a response (commands). For events,` (has `()` despite being English prose)
- **WHEN** the comment is rephrased to remove the confusing parens (e.g., `// if it needs to send a response for commands; for events,`)
- **THEN** no A12 finding SHALL be emitted
- **AND** the rephrase is documented in the implementation so future contributors understand why

