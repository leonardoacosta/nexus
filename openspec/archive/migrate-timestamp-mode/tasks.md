# Implementation Tasks

<!-- beads:epic:nx-a8d4 -->

## DB Batch

- [x] [1.1] [P-1] Change all 17 timestamp columns in 8 schema files from `mode: "string"` to `mode: "date"` [owner:db-engineer] [beads:nx-c6ne]
- [x] [1.2] [P-2] Update inferred types `ProjectLocation`, `NewProjectLocation`, `Project`, `NewProject`, `Agent`, `NewAgent` to reflect Date fields [owner:db-engineer] [beads:nx-5l28]
- [x] [1.3] [P-2] Verify no Drizzle migration is generated (`drizzle-kit generate` produces no diff) [owner:db-engineer] [beads:nx-laf7]

## API Batch

- [x] [2.1] [P-1] Update `Session` interface in `packages/core/src/types/session.ts`: `startedAt`, `lastHeartbeat`, `endedAt` to `Date` / `Date | null` [owner:api-engineer] [beads:nx-5g7u]
- [x] [2.2] [P-1] Update `Credential` interface in `packages/core/src/types/credential.ts`: `leased_at`, `cooldown_until` to `Date` [owner:api-engineer] [beads:nx-ljt9]
- [x] [2.3] [P-1] Update `Notification` interface in `packages/core/src/types/notification.ts`: `created_at`, `sent_at` to `Date` / `Date | undefined` [owner:api-engineer] [beads:nx-llwa]
- [x] [2.4] [P-1] Update `CanonicalProject` interface in `packages/core/src/types/project.ts`: `discoveredAt` to `Date` [owner:api-engineer] [beads:nx-hq0l]
- [x] [2.5] [P-2] Update `apps/agent/src/db/sessions.ts`: remove `.toISOString()` from writes, remove `new Date()` wrappers from reads [owner:api-engineer] [beads:nx-7crb]
- [x] [2.6] [P-2] Update `apps/agent/src/session-manager.ts`: remove string-to-Date conversions for `lastHeartbeat`, `endedAt` comparisons [owner:api-engineer] [beads:nx-y1uv]
- [x] [2.7] [P-2] Update `apps/agent/src/credentials/pool.ts` and `store.ts`: remove `.toISOString()` on cooldown/lease writes, use Date comparisons [owner:api-engineer] [beads:nx-qqan]
- [x] [2.8] [P-2] Update `apps/agent/src/db/health.ts` and `apps/agent/src/db/events.ts`: remove `.toISOString()` from cutoff/timestamp writes [owner:api-engineer] [beads:nx-ndbv]
- [x] [2.9] [P-2] Update `apps/agent/src/db/agent-registry.ts`: remove `.toISOString()` from `lastSeen` writes [owner:api-engineer] [beads:nx-xq5o]
- [x] [2.10] [P-2] Update `apps/agent/src/db/retention.ts`: pass `Date` objects to retention cutoff queries [owner:api-engineer] [beads:nx-41lr]
- [x] [2.11] [P-2] Update `apps/agent/src/db/project-registry.ts`: remove `.toISOString()` from `lastDiscoveredAt` writes and stale-date comparisons [owner:api-engineer] [beads:nx-gloi]
- [x] [2.12] [P-2] Update `apps/agent/src/notifications/buffer.ts` and `manager.ts`: remove `.toISOString()` from `sentAt`/`createdAt` writes [owner:api-engineer] [beads:nx-wuhj]
- [x] [2.13] [P-2] Update `apps/agent/src/routes/notifications.ts`: remove `.toISOString()` from `createdAt` on insert [owner:api-engineer] [beads:nx-ttuk]
- [x] [2.14] [P-2] Update `apps/agent/src/routes/credentials.ts`: remove `.toISOString()` from timestamp fields in route handlers [owner:api-engineer] [beads:nx-6cfd]
- [x] [2.15] [P-2] Update `apps/agent/src/routes/projects-discovered.ts`: remove `new Date(s.lastActivity).getTime()` wrapper [owner:api-engineer] [beads:nx-6qci]
- [x] [2.16] [P-2] Update `apps/agent/src/health-scheduler.ts` and `health-collector.ts`: use `Date` for `timestamp`/`collectedAt` DB writes [owner:api-engineer] [beads:nx-sk6y]
- [x] [2.17] [P-2] Update `apps/agent/src/server.ts`: use `Date` for event timestamp DB writes [owner:api-engineer] [beads:nx-uj6h]

## UI Batch

- [x] [3.1] [P-1] Update `apps/nextjs/src/app/api/projects/route.ts`: remove `.toISOString()` fallback for `discoveredAt` [owner:ui-engineer] [beads:nx-g0je]
- [x] [3.2] [P-1] Update `apps/nextjs/src/app/actions/sessions.ts`: remove `new Date(x).getTime()` wrappers for sort comparisons [owner:ui-engineer] [beads:nx-21k3]
- [x] [3.3] [P-2] Update `apps/nextjs/src/lib/agent-client.ts`: verify `lastSeen` Date handling is consistent [owner:ui-engineer] [beads:nx-nkhy]
- [x] [3.4] [P-2] Update `apps/nexus-register/src/index.ts`: use `Date` for event timestamp if writing to DB [owner:ui-engineer] [beads:nx-30xe]

## E2E Batch

- [x] [4.1] Update all agent test files (`session-manager.test.ts`, `credentials.test.ts`, `project-registry.test.ts`, `sessions.test.ts`, `health-history.test.ts`, `notifications.test.ts`, `db.test.ts`) to use `Date` objects instead of `.toISOString()` strings [owner:e2e-engineer] [beads:nx-l9sx]
- [x] [4.2] Update `apps/nextjs/src/__tests__/acceptance/test-helpers.ts` to use `Date` objects for mock session/project data [owner:e2e-engineer] [beads:nx-wg0b]
- [x] [4.3] Update `apps/nextjs/src/lib/__tests__/format.test.ts` to pass `Date` objects (function already accepts both) [owner:e2e-engineer] [beads:nx-9jy2]
- [x] [4.4] Update `apps/nextjs/src/lib/agent-routing.test.ts` to use `Date` for `discoveredAt` mock [owner:e2e-engineer] [beads:nx-2kqf]
- [x] [4.5] Update `apps/nexus-register/src/register.test.ts` timestamp assertions [owner:e2e-engineer] [beads:nx-p6gb]
- [x] [4.6] Run full test suite and verify zero failures [owner:e2e-engineer] [beads:nx-lxvm]
