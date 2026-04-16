# Implementation Tasks

<!-- beads:epic:nx-zt2e -->

## DB Batch

- [x] [1.1] [P-1] C2 add withTimezone to packages/db/src/schema/sessionTokenTurns.ts:18 + sessionTokenWatcherState.ts:9 [owner:db-engineer] [beads:nx-68gw]
- [x] [1.2] [P-2] Generate Drizzle migration for C2 timestamp changes and apply against local PG [owner:db-engineer] [beads:nx-9dev]
- [x] [1.3] [P-1] C15 trace actual findMany call site (rule flags schema file — real site is in routes or queries) and add limit() [owner:db-engineer] [beads:nx-839z]

## API Batch

- [x] [2.1] [P-1] C5 migrate SQL template literals to sql.placeholder() in credentials/pool.ts:515, token-stream/lifecycle.ts:176, routes/credentials.ts:539 [owner:api-engineer] [beads:nx-vssv]
- [x] [2.2] [P-1] E7 migrate fetch to fetchWithTimeout in credentials/pool.ts:186 + server.ts:743 + scripts/probe-credential-identity.ts:79 [owner:api-engineer] [beads:nx-9ih4]
- [x] [2.3] [P-2] E7 investigate packages/core/src/fetch.ts:15 — suppress as self-ref OR verify prior migration [owner:api-engineer] [beads:nx-qfxj]
- [x] [2.4] [P-2] A9 investigate session-manager.ts:319 + watcher-bridge.ts:119 — fix or file rule-refinement bead [owner:api-engineer] [beads:nx-9v64]

## UI Batch

- [x] [3.1] [P-1] Migrate CommandPalette.tsx:136 + CommandPalette.tsx:139 console.error → Sentry.captureException [owner:ui-engineer] [beads:nx-cqpr]
- [x] [3.2] [P-1] Migrate LazyTerminalPanel.tsx:8 console.error → Sentry.captureException [owner:ui-engineer] [beads:nx-fy1e]
- [x] [3.3] [P-2] A9 investigate CommandPalette.tsx:131 — fix or file rule-refinement bead [owner:ui-engineer] [beads:nx-2dp9]
- [x] [3.4] [P-1] C5 migrate SQL in apps/nextjs/src/app/actions/health.ts:49 to sql.placeholder() or typed query [owner:ui-engineer] [beads:nx-re71]
- [x] [3.5] [P-3] D5 review credentials/page.tsx:80 dangerouslySetInnerHTML — sanitize or suppress with reason [owner:ui-engineer] [beads:nx-qtb5]

## Infra Batch

- [x] [4.1] [P-1] Extend .audit-suppressions.json: A4 CLI scripts/migrations entry, autoSkipTestFiles +A3/A4/F2/B4, A5/A12/B4 defer entries with bead refs [owner:devops-engineer] [beads:nx-hr6u]
- [x] [4.2] [P-1] H1 — add AUDIT_SCAN_BIN to .env.example; suppress HOME (POSIX-universal); decide NX_HAS_PROJECTS (add or suppress) [owner:devops-engineer] [beads:nx-9xkz]
- [ ] [4.3] [P-2] File follow-up beads: 3× A5 TODOs, 2× A12 commented-code sites, 1× B4 production-file-splits spec candidate [owner:devops-engineer] [beads:nx-ftby]
- [x] [4.4] [P-2] A3 — suppress packages/db/src/migrations/** (extends 4.1 entry) and rely on autoSkipTestFiles for test [owner:devops-engineer] [beads:nx-f0h5]

## E2E Batch

- [x] [5.1] [P-1] Update audit-suppressions.integration.test.ts baselines: A4=0, F2=0, A9=0, C5=0, C2=0, C15=0, A3=0, E7<=1, D5<=1 [owner:test-writer] [beads:nx-ytvg]
- [x] [5.2] [P-1] Update composite score threshold to >= 88 with documented rationale [owner:test-writer] [beads:nx-qhka]
- [ ] [5.3] [P-2] Run full audit-scan; document final baseline in test comments; verify all follow-up beads filed and linked [owner:e2e-engineer] [beads:nx-ck6g]
