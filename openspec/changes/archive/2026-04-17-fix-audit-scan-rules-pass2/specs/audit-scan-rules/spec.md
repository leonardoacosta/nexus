# audit-scan-rules Specification

## ADDED Requirements

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
