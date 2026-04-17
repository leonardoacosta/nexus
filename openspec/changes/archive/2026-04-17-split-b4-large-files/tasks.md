# Implementation Tasks

<!-- beads:epic:nx-b1es -->

## API Batch

- [x] [1.1] [P-1] Split apps/agent/src/credentials/pool.ts (1083 lines) into credentials/pool/ subdir: types, errors, core class, rotation (4-5 modules <500 lines each); pool.ts becomes barrel re-export; typecheck + credential-pool.test.ts must pass unchanged [owner:api-engineer] [beads:nx-xprp]
- [x] [1.2] [P-2] Split apps/agent/src/server.ts (786 lines) into helper modules (health-ingest, origin-check, startup); startServer + singletons preserved; all 5 co-located server tests must pass [owner:api-engineer] [beads:nx-jw40]
- [x] [1.3] [P-2] Split apps/agent/src/routes.ts (694 lines) into domain-specific files under routes/ (or routes/index.ts orchestrator); buildRoutes export preserved; no tests depend on internals [owner:api-engineer] [beads:nx-fyzx]
- [x] [1.4] [P-3] Split apps/agent/src/routes/credentials.ts (638 lines) into routes/credentials/ subdir grouped by concern (crud, lease, promote); all 13 exports still importable from routes/credentials path; credentials.test.ts passes [owner:api-engineer] [beads:nx-yrx7]
- [x] [1.5] [P-3] Split apps/agent/src/services/socket-server.ts (521 lines) into services/socket-server/ subdir (types, dispatcher, server); all 9 exports preserved; socket-server.test.ts passes [owner:api-engineer] [beads:nx-0zgx]

## UI Batch

- [x] [2.1] [P-1] Split apps/nextjs/src/components/CredentialsTable.tsx (525 lines) into components/credentials-table/ subdir with sibling components (row, actions, status-cell as natural); main export preserved; Next.js typecheck + build clean [owner:ui-engineer] [beads:nx-wn16]

## Infra Batch

- [ ] [3.1] [P-2] Remove B4 suppression entry covering the 6 production paths from .audit-suppressions.json; preserve autoSkipTestFiles B4 entry; verify CI lint passes [owner:devops-engineer] [beads:nx-aj69]

## E2E Batch

- [x] [4.1] [P-1] Update audit-suppressions.integration.test.ts: add B4 count === 0 assertion for nx repo; confirm composite score holds at ≥ 99 [owner:test-writer] [beads:nx-2hol]
- [ ] [4.2] [P-2] Run full audit-scan; verify B4=0, all tests pass (pnpm turbo run test --filter=@nexus/agent --filter=@nexus/nextjs), typecheck clean; close nx-iwu3 with final verification summary [owner:e2e-engineer] [beads:nx-a5ld]
