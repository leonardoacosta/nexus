# Implementation Tasks

<!-- beads:epic:nx-sv5i -->

## DB Batch

- [x] [1.1] [P-1] Add relations() to packages/db/src/schema/sessions.ts (project, agent) [owner:db-engineer] [beads:nx-m5xq]
- [x] [1.2] [P-1] Add relations() to packages/db/src/schema/projects.ts (agents, sessions) [owner:db-engineer] [beads:nx-urog]
- [x] [1.3] [P-1] Add relations() to packages/db/src/schema/agents.ts (sessions, health, credentials) [owner:db-engineer] [beads:nx-cy8o]
- [ ] [1.4a] [P-2] Add agent_id text NOT NULL column to health_snapshots with backfill + FK CASCADE [owner:db-engineer] [beads:nx-liyj]
- [ ] [1.5a] [P-2] Add agent_id text nullable column to credentials with FK SET NULL [owner:db-engineer] [beads:nx-wt3m]
- [ ] [1.6a] [P-2] Add agent_id text nullable column to notifications with FK SET NULL [owner:db-engineer] [beads:nx-55z3]
- [ ] [1.9c] [P-2] Drop sessions.project and sessions.project_id text columns, add sessions.project_id uuid with FK to projects.id ON DELETE SET NULL [owner:db-engineer] [beads:nx-rck7]
- [ ] [1.4] [P-3] Add relations() to packages/db/src/schema/healthSnapshots.ts (agent) [owner:db-engineer] [beads:nx-mnqf]
- [ ] [1.5] [P-3] Add relations() to packages/db/src/schema/credentials.ts (agent) [owner:db-engineer] [beads:nx-wmip]
- [x] [1.6] [P-1] Add relations() to packages/db/src/schema/notifications.ts (agent for nullable, project for project) [owner:db-engineer] [beads:nx-iu4m]
- [ ] [1.7] [P-4] Create packages/db/src/index.ts barrel with type + query + client exports [owner:db-engineer] [beads:nx-d9zh]
- [ ] [1.8] [P-4] Update packages/db/package.json exports field to publish barrel + add db:migrate script [owner:db-engineer] [beads:nx-q7uj]
- [ ] [1.9] [P-5] Run drizzle-kit generate to produce consolidated migration SQL for all schema changes [owner:db-engineer] [beads:nx-e7o3]
- [ ] [1.10] [P-5] Review generated migration SQL for correctness (DROPs, agent_id backfill, FK types) [owner:db-engineer] [beads:nx-z5u2]
- [ ] [1.11] [P-6] Run pnpm --filter @nexus/db db:migrate against local PG and verify all constraints applied [owner:db-engineer] [beads:nx-n20u]

## API Batch

- [ ] [2.1] [P-1] Create packages/core/src/safe-spawn.ts with ALLOWED_BINARIES + SafeSpawnHandle type [owner:api-engineer] [beads:nx-i1jp]
- [ ] [2.2] [P-1] Implement safeSpawn function with allowlist + arg validation + trustArgs escape [owner:api-engineer] [beads:nx-lw00]
- [ ] [2.3] [P-1] Write unit tests for safeSpawn covering allowlist, validation, trustArgs, abort [owner:test-writer] [beads:nx-wzkc]
- [ ] [2.4] [P-2] Migrate apps/agent/src/terminal/pty-source.ts:131 to safeSpawn [owner:api-engineer] [beads:nx-gbnl]
- [ ] [2.5] [P-2] Migrate apps/agent/src/watcher-bridge.ts (lines 73,79,128,172) to safeSpawn [owner:api-engineer] [beads:nx-gbcg]
- [ ] [2.6] [P-2] Migrate apps/agent/src/utils/exec.ts:70 to safeSpawn re-export [owner:api-engineer] [beads:nx-ji2w]
- [ ] [2.7] [P-2] Migrate apps/agent/src/routes/projects-discovered.ts:64 to safeSpawn [owner:api-engineer] [beads:nx-2ffm]
- [ ] [2.8] [P-3] Add .catch handlers to apps/agent/src/session-manager.ts:303,304 [owner:api-engineer] [beads:nx-23wl]
- [ ] [2.9] [P-3] Add .catch handlers to apps/agent/src/watcher-bridge.ts:118,167 [owner:api-engineer] [beads:nx-hzjt]
- [ ] [2.10] [P-3] Wire streamManager.shutdown() to SIGTERM handler in apps/agent/src/index.ts [owner:api-engineer] [beads:nx-yeyl]
- [ ] [2.11] [P-3] Migrate apps/agent/src/credentials/pool.ts:119 SQL to sql.placeholder() [owner:api-engineer] [beads:nx-i44j]
- [ ] [2.12] [P-3] Migrate apps/agent/src/routes/credentials.ts:302 fetch to fetchWithTimeout [owner:api-engineer] [beads:nx-w6i9]
- [ ] [2.13] [P-3] Migrate apps/agent/src/notifications/channels/tts.ts:20 fetch to fetchWithTimeout [owner:api-engineer] [beads:nx-bsqf]
- [ ] [2.14] [P-3] Migrate apps/agent/src/notifications/channels/slack.ts:19 fetch to fetchWithTimeout [owner:api-engineer] [beads:nx-h6mb]
- [ ] [2.15] [P-3] Migrate apps/agent/src/server.ts:730 fetch to fetchWithTimeout [owner:api-engineer] [beads:nx-1kvy]
- [ ] [2.16] [P-3] Migrate packages/core/src/fetch.ts:15 bare fetch to fetchWithTimeout self-use [owner:api-engineer] [beads:nx-etr3]
- [ ] [2.17] [P-4] Add tilde expansion helper to apps/agent/src/services/project-registry.ts [owner:api-engineer] [beads:nx-5nda]
- [ ] [2.18] [P-4] Apply tilde expansion in agents.toml loader (packages/core/src/config.ts) [owner:api-engineer] [beads:nx-2dyw]
- [ ] [2.19] [P-4] Apply tilde expansion in registry API POST handler [owner:api-engineer] [beads:nx-qwoy]

## UI Batch

- [ ] [3.1] [P-1] Create apps/nextjs/src/lib/db.ts re-export from @nexus/db barrel (replace internal import) [owner:ui-engineer] [beads:nx-zaor]
- [ ] [3.2] [P-1] Update apps/nextjs/src/lib/projects.ts import from @nexus/db [owner:ui-engineer] [beads:nx-8wuu]
- [ ] [3.3] [P-1] Update apps/nextjs/src/lib/get-client.ts import from @nexus/db [owner:ui-engineer] [beads:nx-pjwm]
- [ ] [3.4] [P-1] Update apps/nextjs/src/app/api/projects/route.ts import from @nexus/db [owner:ui-engineer] [beads:nx-eufc]
- [ ] [3.5] [P-1] Update apps/nextjs/src/app/actions/projects.ts import from @nexus/db [owner:ui-engineer] [beads:nx-leni]
- [ ] [3.6] [P-1] Update apps/nextjs/src/app/actions/settings.ts imports from @nexus/db [owner:ui-engineer] [beads:nx-qbpl]
- [ ] [3.7] [P-2] Delete AgentClient.fetchAllSessions from apps/nextjs/src/lib/agent-client.ts [owner:ui-engineer] [beads:nx-695e]
- [ ] [3.8] [P-2] Delete AgentClient.fetchAllHealth from apps/nextjs/src/lib/agent-client.ts [owner:ui-engineer] [beads:nx-7etg]
- [ ] [3.9] [P-2] Delete AgentClient.fetchAllProjects from apps/nextjs/src/lib/agent-client.ts [owner:ui-engineer] [beads:nx-573j]
- [ ] [3.10] [P-2] Replace fetchAllSessions call sites with @nexus/db query function calls [owner:ui-engineer] [beads:nx-yxy6]
- [ ] [3.11] [P-2] Replace fetchAllHealth call sites with @nexus/db query function calls [owner:ui-engineer] [beads:nx-hqo0]
- [ ] [3.12] [P-2] Replace fetchAllProjects call sites with @nexus/db query function calls [owner:ui-engineer] [beads:nx-tr5z]
- [ ] [3.13] [P-3] Add .catch to apps/nextjs/src/components/CommandPalette.tsx:131 promise [owner:ui-engineer] [beads:nx-o8id]
- [ ] [3.14] [P-3] Add .catch to apps/nextjs/src/components/LazyTerminalPanel.tsx:6 promise [owner:ui-engineer] [beads:nx-9lgi]
- [ ] [3.15] [P-3] Replace console.error at CommandPalette.tsx:136 with Sentry.captureException [owner:ui-engineer] [beads:nx-axfi]
- [ ] [3.16] [P-4] Add dashboard banner component for "agents offline" fallback state [owner:ui-engineer] [beads:nx-7g71]
- [ ] [3.17] [P-4] Replace 3 as-any assertions in test helpers with proper types [owner:ui-engineer] [beads:nx-ntxx]

## Infra Batch

- [ ] [4.1] [P-1] Add .audit-suppressions.json reader to scripts/bin/audit-scan [owner:devops-engineer] [beads:nx-apmf]
- [ ] [4.2] [P-1] Implement autoSkipTestFiles glob matcher in audit-scan [owner:devops-engineer] [beads:nx-hzni]
- [ ] [4.3] [P-1] Add suppressions counter to audit-scan JSON output [owner:devops-engineer] [beads:nx-6au4]
- [ ] [4.4] [P-2] Create .audit-suppressions.json at repo root with D4 tmux paths and autoSkipTestFiles E7/E5/A6 [owner:devops-engineer] [beads:nx-0evg]
- [ ] [4.5] [P-2] Lint .audit-suppressions.json in CI to ensure every entry has reason field [owner:devops-engineer] [beads:nx-vv33]
- [ ] [4.6] [P-3] Add CLAUDE_PROJECT_DIR and 2 missing env vars to .env.example [owner:devops-engineer] [beads:nx-b7bx]

## E2E Batch

- [ ] [5.1] Write safeSpawn integration test: spawn real tmux, assert session created, assert clean abort [owner:e2e-engineer] [beads:nx-sxji]
- [ ] [5.2] Write Next.js E2E: dashboard renders sessions list with all agents stopped [owner:e2e-engineer] [beads:nx-3wpy]
- [ ] [5.3] Write Next.js E2E: attach still works via WebSocket when agent is up [owner:e2e-engineer] [beads:nx-cjz0]
- [ ] [5.4] Write migration test: FK added cleanly against snapshot with orphan sessions [owner:e2e-engineer] [beads:nx-gkgm]
- [ ] [5.5] Write audit-scan integration test: suppression config reduces D4 count to expected production-only sites [owner:e2e-engineer] [beads:nx-96u9]
- [ ] [5.6] Run full audit-scan and assert composite >= 90, architecture axis >= 85 [owner:e2e-engineer] [beads:nx-7jfa]
- [ ] [5.7] Bulk-close audit beads whose scope is covered: nx-acu2, nx-tev9, nx-8v2a [owner:devops-engineer] [beads:nx-iqwd]
