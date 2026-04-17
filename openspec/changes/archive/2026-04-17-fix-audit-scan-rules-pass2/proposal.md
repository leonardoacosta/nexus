# Proposal: Fix Audit Scan Rules Pass 2

## Change ID
`fix-audit-scan-rules-pass2`

## Summary
Second pass of audit-scan rule refinements. The A9 rule's 4-line catch lookahead misses `.then(A).then(B).catch(C)` chains and `safeFireAndForget(...)` wrapper usage. The E7 rule's `\bfetch\s*\(` regex matches Bun.serve method shorthand (`fetch(req, server) { ... }`) — a property definition, not a fetch call. Both produced false positives that required narrow suppressions in the last cleanup wave; fixing the rules retires those suppressions and restores audit visibility into the real patterns.

## Context
- Extends: `~/.claude/scripts/bin/audit-scan` (A9 block lines 393-401, E7 block lines 659-671)
- Related archives: `2026-04-16-fix-audit-scan-rules` (Pass 1 — B2 regex + A9 void marker removal), `2026-04-16-fix-audit-real-debt` (surfaced both rule gaps while investigating A9 and E7 sites)
- Related beads (both closed by this spec): `nx-at1t` (A9 chain-terminal + safeFireAndForget recognition), `nx-77ra` (E7 Bun.serve method-shorthand skip)
- Capability: `audit-scan-rules` (existing — this spec adds 2 new requirements)

## Motivation

The previous audit cleanup wave uncovered two rule gaps during investigation:

1. **A9's 4-line lookahead is too short.** The rule checks lines `line..line+3` for `.catch(`. Chains like `p.then(fetch).catch(abort).then(parse).then(render)` have the terminal `.catch()` before the `.then(render)` at a later line, so the rule flags `render` as unhandled. It also doesn't recognize the `safeFireAndForget(p, ctx)` wrapper which adds its own `.catch()` externally. Result in nx: 3 false positives required suppression via `.audit-suppressions.json` even though the code is correctly handled.

2. **E7's regex catches Bun.serve fetch method shorthand.** `Bun.serve({ fetch(req, server) { return handler(req) } })` uses `fetch` as a property name on the options object — a method shorthand, not a function call. The regex `\bfetch\s*\(` matches both. Result in nx: `apps/agent/src/server.ts:743` required a file-level E7 suppression.

Fixing both rules is ~30 minutes of work each, retires the narrow suppressions, and restores honest reporting. These refinements benefit every project that uses audit-scan — the binary lives at `~/.claude/scripts/bin/`, shared across all Leo's repos.

## Requirements

### Requirement: A9 chain-terminal catch detection
The A9 rule SHALL detect `.catch(` anywhere in the enclosing statement (from the start of the expression to the terminating `;` or end-of-statement), not just within a fixed line window. A `.then(...)` followed eventually by a `.catch(...)` on the same chain — even if intervening `.then(...)` calls extend the chain — SHALL NOT produce an A9 finding.

### Requirement: A9 safeFireAndForget wrapper detection
The A9 rule SHALL recognize the `safeFireAndForget(...)` wrapper (from `apps/agent/src/utils/safe-fire-and-forget.ts`) as a catch-equivalent. Any `.then(...)` whose Promise is passed into `safeFireAndForget(...)` as an argument SHALL NOT produce an A9 finding.

### Requirement: E7 Bun.serve method-shorthand skip
The E7 rule SHALL distinguish `fetch(...)` function calls from `fetch(req, server) {...}` method-shorthand definitions. Lines where `fetch(` appears as a property definition on an object literal (first argument named `req`/`request`, parameters followed by `{` body) SHALL NOT produce an E7 finding.

### Requirement: Stale suppressions removed
The existing `.audit-suppressions.json` entries that were added ONLY to paper over the two rule bugs fixed above SHALL be removed. Specifically: the A9 entry covering `session-manager.ts`, `watcher-bridge.ts`, `CommandPalette.tsx` AND the E7 entry covering `apps/agent/src/server.ts` SHALL be deleted. Other suppressions (A9/E7 for unrelated sites, if any remain) SHALL be preserved.

### Requirement: Regression-guard tests for both refinements
The audit-scan test suite SHALL cover both rule changes with fixture-style tests: at least one positive case and one negative case per refinement. Fixtures SHALL live alongside existing fixture tests in `packages/core/src/audit-suppressions.integration.test.ts`.

### Requirement: Nx-repo baselines hold
After the rule patches and suppression removals, running audit-scan against `/home/nyaptor/dev/nx` SHALL still emit A9 = 0 and E7 = 0. The integration test SHALL assert this. Composite score SHALL NOT regress from the current 99/A.

## Scope

- **IN**: A9 chain-terminal detection patch, A9 safeFireAndForget wrapper detection, E7 Bun.serve method-shorthand skip, removal of the 2 stale suppression entries, fixture + integration tests for both refinements
- **OUT**: Other rule refinements (A2/A12 line ranges, C-category heuristics), B4 large-file splits (tracked in `nx-iwu3`), any non-rule audit-scan changes, changes to `autoSkipTestFiles`

## Impact

| Area | Change |
|------|--------|
| `~/.claude/scripts/bin/audit-scan` | A9 block (lines ~393-401) — expand catch lookahead to chain/statement scope + detect `safeFireAndForget(` wrapper |
| `~/.claude/scripts/bin/audit-scan` | E7 block (lines ~659-671) — skip method-shorthand fetch (context detection before emit) |
| `.audit-suppressions.json` | Remove 2 entries: the A9 entry covering 3 paths, the E7 entry for `server.ts`. File shrinks from 19 → 17 entries. |
| `packages/core/src/audit-suppressions.integration.test.ts` | +4-6 new fixture tests (A9 chain-terminal, A9 safeFireAndForget, E7 Bun.serve shorthand) |

## Risks

| Risk | Mitigation |
|------|-----------|
| A9 chain detection is too permissive and masks real unhandled rejections in long chains | Define "chain" narrowly — only descend to the terminating `;` or newline without `.`. A freshly-started Promise (assignment or `return`) restarts the scope. Covered by negative fixture: `p.then(A); q.then(B);` — second one must still flag |
| A9 safeFireAndForget detection matches other functions containing "fireAndForget" in the name | Match the exact identifier `safeFireAndForget` only; document the convention |
| E7 method-shorthand detection is too aggressive and skips real fetch calls | Require first arg to be named `req` OR `request` (standard Bun.serve convention); any other first-arg name keeps the fetch-call interpretation. Positive fixture: `Bun.serve({ fetch(req) { ... } })` → skip; negative: `const x = fetch('/api')` → flag |
| Removing suppressions before rule patches land breaks CI | Sequence in apply: patch the rules first (Infra tasks 1.1/1.2), run audit-scan to verify no new flags, THEN remove suppressions (Infra task 1.3). Integration-test updates (E2E batch) come last |
| Cross-repo impact on other projects using audit-scan | These are strict refinements (fewer false positives, no new false positives). Net effect is "findings count drops" for any project that had these patterns. Safe migration |

## Open Questions

- Should A9's "enclosing statement" detection reuse an existing helper in audit-scan, or be a dedicated small function? **Decision**: dedicated — current audit-scan doesn't have enclosing-statement parsing; keep it narrow and testable.
- Should safeFireAndForget detection be hardcoded to that name, or configurable? **Decision**: hardcoded for now. If another project has a differently-named wrapper, they can add a suppression — configurability is premature.
