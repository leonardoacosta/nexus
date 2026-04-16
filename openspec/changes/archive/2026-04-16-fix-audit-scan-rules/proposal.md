# Proposal: Fix Audit Scan Rules

## Change ID
`fix-audit-scan-rules`

## Summary
Patch two over-reporting rules in `audit-scan` so the score reflects real debt, not stale pattern matches. B2 currently flags imports from `@nexus/db` (the public barrel we just created) as "internal-import" violations, and A9 counts explicit `void fn()` fire-and-forget patterns as unhandled rejections. Fixing both closes an open spec requirement from `dashboard-data-paths` and unblocks honest score tracking for the follow-up debt-cleanup spec.

## Context
- Extends: `~/.claude/scripts/bin/audit-scan` (lines 406-422 B2 block, A9 detection block)
- Related archives: `2026-04-16-finalize-audit-cleanup` (created the `@nexus/db` barrel that B2 now falsely flags; introduced the suppression engine)
- Related capability: `audit-suppressions` (existing — config-driven skips; this spec is complementary, fixing the rules themselves)
- Related spec requirement in violation: `openspec/specs/dashboard-data-paths/spec.md` § "Next.js imports from the public API" scenario: "audit-scan SHALL NOT emit a B2 finding for that import"

## Motivation
The 2026-04-10 audit wave landed substantive structural cleanup (safeSpawn, dual-path collapse, DB FKs, suppression engine) but composite score moved from 72 → 71 — essentially flat. Root-cause analysis of the 144 remaining findings revealed two overcounted rules:

1. **B2 false positives (9 errors, 100% of architecture errors)**: The regex `from ['\"]@[^/]+/(db|api/src)` matches both `@nexus/db` (public barrel, correct usage) and `@nexus/db/src/schema/sessions` (deep import, real violation). Since the finalize-audit-cleanup spec moved all Next.js imports to the barrel, every remaining "violation" is a false positive. The `dashboard-data-paths` spec explicitly requires these not to be flagged — the rule is now in direct conflict with a shipped spec.

2. **A9 overcounting (9 of 12 errors = 75%)**: The rule flags any `.then()` without `.catch()` AND any "void function call" as unhandled rejections. But `void fn()` is the standard TypeScript fire-and-forget marker — the explicit void IS the handling. All 9 credentials/pool.ts A9 hits use this pattern intentionally. The remaining 3 A9 errors (CommandPalette, session-manager, watcher-bridge) are real unhandled rejections that the previous spec's `.catch` tasks missed.

Fixing both rules takes ~30 minutes, closes an open spec requirement, and gives the follow-up spec (`nx-hqu4`) an honest baseline to measure against.

## Requirements

### Requirement: B2 must recognize public barrel imports

The B2 rule SHALL only flag imports that reach INTO a package (e.g., `@scope/pkg/src/...`, `@scope/pkg/internal/...`), not bare-package imports (e.g., `@scope/pkg`). The updated regex SHALL require at least one path segment after the package name.

### Requirement: B2 still flags deep imports

The B2 rule SHALL continue to flag deep imports that bypass the barrel — e.g., `@nexus/db/src/schema/sessions` or `@nexus/api/src/routers/foo`. The fix narrows false positives without weakening enforcement of the intended boundary.

### Requirement: A9 must distinguish explicit void markers

The A9 rule SHALL NOT flag `void expression` statements where `void` is the unary operator on an async call (TypeScript idiom for explicit fire-and-forget). The rule SHALL continue to flag `.then(...)` chains without a `.catch(...)` and bare async calls whose return is discarded without `void`.

### Requirement: audit-scan tests cover both rule changes

The audit-scan test fixtures SHALL include at least one positive and one negative case per fixed rule. Specifically: a barrel import that MUST NOT be flagged by B2, a deep import that MUST be flagged by B2, a `void fn()` that MUST NOT be flagged by A9, and a `.then()` without `.catch()` that MUST be flagged by A9.

### Requirement: Post-fix baseline verification

After the rules are patched, running audit-scan against `/home/nyaptor/dev/nx` SHALL emit zero B2 findings for any file whose imports from `@nexus/db` or `@nexus/api` resolve to the bare package. The A9 count SHALL drop from 12 to the 3 real unhandled rejections (or the exact number the refined rule finds — must be documented in the task completion note).

## Scope

- **IN**: B2 regex patch, A9 void-pattern detection, rule unit tests in audit-scan test suite, baseline verification against nx repo, update of `audit-scan` help/comments describing the narrowed semantics
- **OUT**: Creating new rule IDs, changing scoring weights, fixing findings surfaced by the refined rules (that's a separate debt spec), other rule refinements (C-category, E-category, F-category — each needs its own analysis)

## Impact

| Area | Change |
|------|--------|
| `~/.claude/scripts/bin/audit-scan` (B2 block, lines 406-422) | Tighten regex to require path-after-package; update "UI imports from internal db/api path" message |
| `~/.claude/scripts/bin/audit-scan` (A9 block) | Add void-prefix detection before flagging fire-and-forget |
| audit-scan test fixtures (location TBD — repo or `~/.claude/scripts/tests/`) | Add positive + negative cases per rule |
| `packages/core/src/audit-suppressions.integration.test.ts` | Add regression assertion that B2 count is 0 post-fix |
| `openspec/changes/finalize-audit-cleanup` archived (follow-up closure) | Not modified directly, but task 5.6's "composite >= 90" gate becomes achievable |

## Risks

| Risk | Mitigation |
|------|-----------|
| Narrowing B2 hides a real deep-import regression | Retain the existing pattern logic for deep imports; only add the trailing-slash requirement. Covered by "B2 still flags deep imports" requirement + positive test case |
| A9 void-detection misses wrapper patterns (e.g., `void (await fn())`) | Start with the simple `void call(...)` detection; document in tests what's intentionally out of scope |
| audit-scan binary lives in `~/.claude/scripts/bin/` (shared across projects) — changes affect all other repos too | Every other project using audit-scan benefits from the same fix; verify by running audit-scan against a known-clean project after the patch |
| Tests added to `~/.claude/scripts/tests/` aren't wired into any CI — regressions could land silently | Mitigate by calling the test runner from the repo's `audit-suppressions.integration.test.ts` — that already has CI coverage via `pnpm test` |

## Open Questions

- Should the refined B2 keep ID `B2` or become `B2b`? **Decision**: Keep `B2` — this is a behavior fix, not a new rule. Downstream consumers (suppressions config, reports) don't need to re-key.
- Should A9's void-detection also cover `_ = someCall()` assignment-to-discard patterns? **Decision**: No — not idiomatic TS, out of scope. Revisit if it surfaces.
