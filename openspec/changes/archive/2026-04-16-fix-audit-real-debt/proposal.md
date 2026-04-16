# Proposal: Fix Audit Real Debt

## Change ID
`fix-audit-real-debt`

## Summary
The third and final audit cleanup spec — handles all REAL debt after Waves 1 (rule fixes) and 2 (suppression extensions). Migrates remaining `console.error` sites to Sentry, fixes 4 fetch sites without timeout, adds `.catch()` to 3 real unhandled rejections, migrates 4 SQL template literals to `sql.placeholder()`, tightens 2 bare `timestamp()` columns, bounds 1 unbounded `findMany()`, reviews 1 `dangerouslySetInnerHTML` for XSS, adds missing env-var documentation, and closes small suppression gaps. Defers B4 large-file splits and A5/A12 stylistic debt to tracked follow-up beads.

## Context
- Extends: `apps/nextjs/src/components/CommandPalette.tsx`, `apps/nextjs/src/components/LazyTerminalPanel.tsx`, `apps/nextjs/src/app/credentials/page.tsx`, `apps/agent/src/credentials/pool.ts`, `apps/agent/src/credentials/token-stream/lifecycle.ts`, `apps/agent/src/routes/credentials.ts`, `apps/agent/src/server.ts`, `apps/agent/src/session-manager.ts`, `apps/agent/src/watcher-bridge.ts`, `packages/core/src/fetch.ts`, `packages/db/src/schema/sessionTokenTurns.ts`, `packages/db/src/schema/sessionTokenWatcherState.ts`, `packages/db/src/schema/notifications.ts`, `apps/nextjs/src/app/actions/health.ts`, `packages/db/src/migrations/backfill-credential-fingerprints.ts`, `.audit-suppressions.json`, `.env.example`
- Related archives: `2026-04-16-extend-audit-suppressions` (previous spec — current baseline 83/B), `2026-04-16-fix-audit-scan-rules` (Wave 1 rule fixes), `2026-04-16-finalize-audit-cleanup` (created Sentry scaffold, fetchWithTimeout helper, added 6 .catch sites — three more remain)
- Related beads: `nx-agsx` (P3 follow-up from previous spec — UI console.error → Sentry; this spec closes it), `nx-hqu4` (parent raise-audit-score spec — this spec is the third and last component)
- Current baseline: composite 83/B, quality 85, structure 87, architecture 77; 64 findings (11 real + 9 B4 + 7 info-level)

## Motivation

After the first two specs in the series, the remaining 64 findings split into:
- **~20 real debt items** this spec fixes (A4/F2 UI Sentry, E7 fetch, A9 unhandled, C5/C2/C15 DB, A3 structured log, D5 XSS, H1 env vars)
- **9 B4 large-file splits** (deferred — tracked as separate follow-up spec; production files `pool.ts`, `server.ts`, `routes.ts`, `routes/credentials.ts`, `socket-server.ts`, `CredentialsTable.tsx`)
- **5 A5/A12 stylistic infos** (deferred — one bead per TODO + suppression entry)
- **misc F5/F8/G10 info-level** (not blocking — PostHog, /api/health, env naming)

The three A9 findings deserve special attention: `CommandPalette.tsx:131`, `session-manager.ts:319`, `watcher-bridge.ts:119` were supposedly fixed by `finalize-audit-cleanup` tasks 3.13 / 2.8 / 2.9 respectively but are still flagged. Either the fix landed in a form audit-scan doesn't detect (e.g., `.then(onSuccess, onError)` two-arg form instead of `.catch()`), or the fix was lost. This spec re-verifies each site and either fixes properly or documents why the audit rule is too strict.

**Expected score impact:** composite 83 → 88-92. Each fix removes a counted finding without introducing new debt.

## Requirements

### Requirement: UI console.error → Sentry migration (closes nx-agsx)
`apps/nextjs/src/components/CommandPalette.tsx` lines 136 and 139 AND `apps/nextjs/src/components/LazyTerminalPanel.tsx` line 8 SHALL migrate from `console.error(...)` to `Sentry.captureException(...)`. The beads issue `nx-agsx` SHALL be closed on completion.

### Requirement: Real A9 unhandled rejections fixed or reclassified
The three currently-flagged A9 sites SHALL be investigated. For each, either (a) apply a proper `.catch()` handler if the site is genuinely unhandled, OR (b) document why the existing handling is equivalent-but-unrecognized by audit-scan and file a follow-up bead to refine the audit rule. All three SHALL disappear from the audit output — whether via code fix or via rule refinement.

### Requirement: Production fetch timeouts (E7)
The 4 remaining E7 sites SHALL be migrated to use `fetchWithTimeout` from `@nexus/core` or an equivalent `AbortController`-based timeout. Exception: `packages/core/src/fetch.ts:15` IS the wrapper — if it still flags after the last spec's migration, the rule is double-counting the wrapper itself, similar to how safeSpawn self-referenced D4. In that case, suppress with reason.

### Requirement: SQL placeholder migration (C5)
The 4 C5 sites (`credentials/pool.ts:515`, `token-stream/lifecycle.ts:176`, `routes/credentials.ts:539`, `app/actions/health.ts:49`) SHALL migrate SQL template interpolation to `sql.placeholder()` or Drizzle's typed query builder to eliminate injection surface.

### Requirement: Timezone-aware timestamp columns (C2)
The 2 C2 sites (`schema/sessionTokenTurns.ts:18`, `schema/sessionTokenWatcherState.ts:9`) SHALL replace bare `timestamp()` with `timestamp({ mode: "date", withTimezone: true })`. A Drizzle migration SHALL be generated and applied if column metadata changes.

### Requirement: Bounded findMany (C15)
The `findMany()` call at `packages/db/src/schema/notifications.ts:26` (or wherever the actual query site is — the rule may be misreporting) SHALL add a reasonable `limit()` clause to prevent unbounded row returns. An appropriate default (e.g., `limit(500)` or paginated via cursor) SHALL be chosen based on the call site's UX contract.

### Requirement: Structured logging for CLI migrations (A3)
The 3 A3 sites in `packages/db/src/migrations/backfill-credential-fingerprints.ts` SHALL be handled. Options: (a) suppress A3 for `packages/db/src/migrations/**` matching the existing A2/F2 CLI-script pattern — preferred since migrations are CLI output, or (b) add a structured logger import. The 1 A3 site in `packages/core/src/safe-spawn.integration.test.ts:90` SHALL be handled by adding A3 to `autoSkipTestFiles`.

### Requirement: dangerouslySetInnerHTML review (D5)
The D5 site at `apps/nextjs/src/app/credentials/page.tsx:80` SHALL be investigated. If user-controlled data flows into it, the rendering SHALL migrate to a sanitized approach (DOMPurify, `children` instead of `__html`, or markdown-to-JSX). If the content is a constant literal with no user data, the site SHALL be suppressed with reason documenting the invariant.

### Requirement: Env var documentation gaps (H1)
`AUDIT_SCAN_BIN` SHALL be added to `.env.example` with a documentation comment. `HOME` SHALL be suppressed via a new rule clause OR left documented as system-provided (the rule is overreporting — HOME is POSIX-universal). `NX_HAS_PROJECTS` SHALL either be added to `.env.example` as a test feature flag or suppressed as test-only.

### Requirement: A4 suppression gap closure
`.audit-suppressions.json` SHALL be extended with an A4 entry covering the same CLI-script paths that the existing F2 entry covers (`apps/agent/src/scripts/**`, `packages/db/src/migrate.ts`, and the newly touched `packages/db/src/migrations/**`). Additionally, `autoSkipTestFiles` SHALL be extended to include `A4`, `F2`, and `B4` — test files legitimately use `console.error`, and large test files are not architectural debt.

### Requirement: Deferred-but-tracked debt (A5 TODO, A12 commented code, B4 large files)
For each A5 TODO finding (3 total), a P3 beads issue SHALL be filed describing the TODO's context and linking this spec. Same pattern for each A12 commented-code finding (2 total). For B4, a single P2 follow-up spec-candidate bead SHALL be filed describing the 4-6 production files that need splitting (`credentials/pool.ts` at 1078 lines leading the list). All three rule IDs SHALL be added to `.audit-suppressions.json` with an explicit `reason` referencing the filed beads.

### Requirement: Post-cleanup audit baseline
After this spec lands, the audit-scan integration test SHALL assert: A4 = 0, F2 = 0, E7 count ≤ 1 (wrapper self-ref if suppressed), A9 = 0, C5 = 0, C2 = 0, C15 = 0, A3 = 0, D5 ≤ 1 (possibly suppressed), and composite score ≥ 88. The integration test file SHALL document which findings moved to which follow-up bead.

## Scope

- **IN**: All A4/F2 UI Sentry migrations, 4 E7 fetch timeouts, 3 A9 investigations/fixes, 4 C5 SQL placeholders, 2 C2 timestamp fixes, 1 C15 findMany limit, 4 A3 structured-log calls, 1 D5 XSS review, 3 H1 env var additions/suppressions, A4 suppression gap + autoSkipTestFiles extensions, A5/A12/B4 follow-up beads + suppression entries, integration-test baseline updates
- **OUT**: B4 production-file splits (files > 500 lines — follow-up spec), A5 TODO code fixes (follow-up beads), A12 commented-code deletions (follow-up beads), F5 PostHog setup, F8 /api/health endpoint, G10 env naming convention (info-level, not blocking score), any new feature work, any code changes outside the flagged sites

## Impact

| Area | Change |
|------|--------|
| `apps/nextjs/src/components/CommandPalette.tsx` | Lines 136, 139 `console.error` → `Sentry.captureException` |
| `apps/nextjs/src/components/LazyTerminalPanel.tsx` | Line 8 `console.error` → `Sentry.captureException` |
| `apps/nextjs/src/components/CommandPalette.tsx` | Line 131 investigate A9 (prior fix may have used `.then(success, error)` two-arg form) |
| `apps/agent/src/session-manager.ts` | Line 319 investigate A9 |
| `apps/agent/src/watcher-bridge.ts` | Line 119 investigate A9 |
| `apps/agent/src/credentials/pool.ts` | Line 186 fetch → `fetchWithTimeout`; line 515 SQL → `sql.placeholder()` |
| `apps/agent/src/credentials/token-stream/lifecycle.ts` | Line 176 SQL → `sql.placeholder()` |
| `apps/agent/src/routes/credentials.ts` | Line 539 SQL → `sql.placeholder()` |
| `apps/agent/src/server.ts` | Line 743 fetch → `fetchWithTimeout` |
| `apps/agent/src/scripts/probe-credential-identity.ts` | Line 79 fetch → `fetchWithTimeout` (scripts need timeouts too) |
| `packages/core/src/fetch.ts` | Line 15 — either suppress as self-ref OR verify migration actually landed |
| `apps/nextjs/src/app/actions/health.ts` | Line 49 SQL → `sql.placeholder()` or typed query |
| `packages/db/src/schema/sessionTokenTurns.ts` | Line 18 timestamp → withTimezone |
| `packages/db/src/schema/sessionTokenWatcherState.ts` | Line 9 timestamp → withTimezone |
| `packages/db/src/schema/notifications.ts` | Line 26 — trace to actual findMany call site, add `limit()` |
| `packages/db/drizzle/` | New migration for timestamp column changes (if Drizzle generates one) |
| `packages/db/src/migrations/backfill-credential-fingerprints.ts` | A3 — suppress via .audit-suppressions.json (migrations/**) |
| `apps/nextjs/src/app/credentials/page.tsx` | Line 80 — D5 investigation, sanitize or suppress |
| `.env.example` | Add `AUDIT_SCAN_BIN`; decide on `NX_HAS_PROJECTS`; leave `HOME` for suppression |
| `.audit-suppressions.json` | +A4 CLI entry; extend autoSkipTestFiles with A4, F2, B4, A3; +A5, A12, B4 entries with follow-up bead refs |
| `.beads/` | File ~5 follow-up issues: 3 A5 TODOs, 2 A12 commented-code sites, 1 B4 large-file-split spec candidate |
| `packages/core/src/audit-suppressions.integration.test.ts` | Update baseline: A4=0, F2=0 (was 3), A9=0 (was 3 from last spec), E7≤1, C5/C2/C15=0, A3=0, D5≤1, score≥88 |

## Risks

| Risk | Mitigation |
|------|-----------|
| A9 investigations reveal the prior spec's fix WAS correct and the audit rule is at fault | Route through audit-scan rule refinement (file follow-up to refine A9 detection for two-arg `.then()`, similar to the B2/A9 rule fixes already shipped); document the rule gap in this spec's Open Questions |
| C2 timestamp migration requires Drizzle migration + running against production data | Use `timestamp({ mode: "date", withTimezone: true })` default in schema; verify migration is additive (column type change via `ALTER COLUMN TYPE`); test against a scratch schema the way the `migration-0010-orphans.test.ts` pattern does |
| C15 findMany — wrong file flagged (schema file, not query file); fix applied to wrong site | Trace the actual call site before changing; audit-scan's line reference is approximate. Use `grep -rn "findMany" packages/db apps/agent` to locate the real unbounded query |
| D5 sanitization breaks existing rendering (e.g., trusted HTML from a known-safe source) | Read the site first. If the source is a constant literal, suppress. If it's user data, use DOMPurify or rewrite to JSX children — don't silently remove the rendering |
| E7 `packages/core/src/fetch.ts:15` is the wrapper and should not be flagged | If rule flags the wrapper itself, suppress with reason. Do NOT "fix" the wrapper by importing itself — that's a self-reference cycle. Pattern matches how safeSpawn self-ref is handled |
| H1 HOME suppression leaks into real forgotten env vars | Scope the suppression narrowly to well-known POSIX vars (`HOME`, `USER`, `PATH`). Document in .audit-suppressions.json `reason` field |
| Score gate (≥88) blocks archive if rule refinements needed | Assert as soft gate — if A9 requires rule work, adjust baseline assertion to match the actual post-fix count and document the gap |

## Open Questions

- **D5 content source** — `apps/nextjs/src/app/credentials/page.tsx:80` needs a read to determine: is the inner-HTML from a literal, from a component prop (potentially user-controlled), or from a markdown-rendering util? The mitigation path depends on this. Default: if unclear, err toward sanitize-via-DOMPurify.
- **C15 limit value** — `findMany` call needs a sensible limit. For `notifications`, proposed: `limit(500)` with cursor pagination if future work needs it. If the call is on a per-agent or per-user scope, the limit may be implicit via the `WHERE` clause — in which case the fix is to add an explicit `limit()` anyway as a defense-in-depth.
- **A9 audit rule too strict?** — if the 3 remaining A9 sites actually have `.then(success, failure)` two-arg form (a valid error handling pattern in the Promise spec), the audit-scan rule should be refined to accept it. This would be a follow-up to `fix-audit-scan-rules`, not part of this spec.
