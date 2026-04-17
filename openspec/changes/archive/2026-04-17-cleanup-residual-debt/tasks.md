# Implementation Tasks

<!-- beads:epic:nx-ajr1 -->

## DB Batch

- [x] [1.1] [P-1] Implement 2 skipped session-CRUD tests in apps/agent/src/db/db.test.ts using scratch-schema pattern from migration-0010-orphans.test.ts; remove describe.skip wrapper [owner:test-writer] [beads:nx-qmvn]

## API Batch

- [x] [2.1] [P-1] Replace os.hostname() at projects-discovered.ts:54 (and other agent-ID lookup sites) with config-sourced agent ID + hostname fallback when no config [owner:api-engineer] [beads:nx-43nb]
- [x] [2.2] [P-1] Add cursor + limit query params to GET /projects and GET /projects/discovered; include nextCursor in response; preserve truncated:true fallback [owner:api-engineer] [beads:nx-z84e]
- [x] [2.3] [P-1] Add server-side 403 for non-Tailscale Origin in agent HTTP router; preserve OPTIONS preflight + no-Origin passthrough [owner:api-engineer] [beads:nx-63dk]
- [ ] [2.4] [P-1] Add {mode: 0o600} to writeFileSync calls at apps/nexus-status/src/index.ts:266 and 304 (usage-cache.json + profile-cache.json) [owner:api-engineer] [beads:nx-fcvg]

## UI Batch

- [ ] [3.1] [P-2] If any Next.js consumer depends on /projects returning all rows, note the change in code comment; defer any pagination UI work to follow-up bead if needed [owner:ui-engineer] [beads:nx-z8po]

## Infra Batch

- [x] [4.1] [P-1] Refine A12 rule in ~/.claude/scripts/bin/audit-scan to require code-syntax signal (=, (), ;, or { on same line) in addition to keyword prefix [owner:devops-engineer] [beads:nx-pi3g]
- [x] [4.2] [P-1] Rephrase comment at socket-server.test.ts:80 to remove confounding parens ("(commands)" → "for commands"); confirms A12 refinement + prevents re-flag [owner:devops-engineer] [beads:nx-o4u9]
- [x] [4.3] [P-2] File new P3 bead with label audit-debt: "Add credential_swaps table to track credential rotation per session"; update attribution.ts:42 TODO comment to reference that bead ID [owner:devops-engineer] [beads:nx-ipj7]
- [ ] [4.4] [P-3] Remove stale .audit-suppressions.json entries (A5 × 2 for attribution.ts + db.test.ts, A12 × 2 for socket-server.test.ts + session-manager.ts); verify CI lint exit 0 [owner:devops-engineer] [beads:nx-glij]

## E2E Batch

- [x] [5.1] [P-1] Add A12 fixture tests: var-decl with = flag, call with () flag, bare keyword prose skip, rephrased parens-in-prose skip [owner:test-writer] [beads:nx-cfuw]
- [x] [5.2] [P-1] Update audit-suppressions.integration.test.ts baselines: A12=0, A5=0, score unchanged at 99+ [owner:test-writer] [beads:nx-2dvt]
- [x] [5.3] [P-2] E2E test for cursor pagination: 120 seeded projects, limit=50 returns page 1 + nextCursor; follow-cursor returns page 2; page 3 returns 20 + no nextCursor [owner:e2e-engineer] [beads:nx-4o74]
- [ ] [5.4] [P-2] Test CORS 403: non-Tailscale Origin + valid secret gets 403; OPTIONS preflight passes; no-Origin curl passes with auth [owner:e2e-engineer] [beads:nx-ugxw]
- [ ] [5.5] [P-3] Run full audit-scan; verify A12=0 and A5=0; close nx-hza9, nx-3sih, nx-xxq5, nx-469c, nx-mnrr, nx-9yrx, nx-fa79, nx-qgnq [owner:e2e-engineer] [beads:nx-b9pd]
