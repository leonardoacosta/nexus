# Implementation Tasks

<!-- beads:epic:nx-39v6 -->

## UI Batch

- [x] [1.1] [P-1] Remove console.warn from HealthPoller.tsx:55 — delete the catch body's console.warn line, keep the empty catch (stale data retention is the design) [owner:ui-engineer] [beads:nx-puye]

## API Batch

- [x] [2.1] [P-1] Create TestAgentClient subclass in apps/nextjs/src/lib/__tests__/test-agent-client.ts that extends AgentClient and exposes seedDiscoveredProject() method [owner:api-engineer] [beads:nx-f6l9]
- [x] [2.2] [P-2] Replace `as any` casts in agent-client.test.ts:327,353 with TestAgentClient usage [owner:api-engineer] [beads:nx-3qlq]

## E2E Batch

- [x] [3.1] [P-1] Extract shared helpers from credentials.test.ts into credentials.helpers.ts (mock DB setup, pool factory, common fixtures) [owner:e2e-engineer] [beads:nx-zhnb]
- [x] [3.2] [P-1] Split credentials.test.ts into credential-crud.test.ts (CRUD ops), credential-pool.test.ts (lease/release/cooldown), credential-encryption.test.ts (encrypted storage), credential-tls.test.ts (TLS enforcement), credential-health.test.ts (health check endpoint) [owner:e2e-engineer] [beads:nx-q4jc]
- [x] [3.3] [P-1] Split server.test.ts into server-health.test.ts, server-cors.test.ts, server-websocket-auth.test.ts, server-websocket-lifecycle.test.ts, server-ingest.test.ts [owner:e2e-engineer] [beads:nx-vt7k]
- [x] [3.4] [P-1] Split agent-client.test.ts into agent-client-core.test.ts (CRUD + caching), agent-client-discovery.test.ts (stale eviction), agent-client-dedup.test.ts (deduplication) [owner:e2e-engineer] [beads:nx-focs]
- [x] [3.5] [P-1] Split projects-discovered.test.ts into projects-expand.test.ts (expandProjectsDir), projects-discovered-core.test.ts (main handler), projects-discovered-edge.test.ts (traversal, symlinks, truncation) [owner:e2e-engineer] [beads:nx-0tuj]
- [x] [3.6] [P-2] Delete original oversized test files after verifying all split files pass [owner:e2e-engineer] [beads:nx-wevq]
- [x] [3.7] [P-2] Run full test suite (bun test in apps/agent + nextjs test) and confirm pass count matches baseline [owner:e2e-engineer] [beads:nx-5v1y]
