# Implementation Tasks

<!-- beads:epic:nx-42q1 -->

## API Batch

- [ ] [1.1] [P-1] Create `apps/agent/src/context.ts`: define AppContext interface with all shared state (db, config, sessionManager, lifecycleBus, commandState, notificationDedup, credentialPool, environmentCache, failureBuffer, commandRegistry), plus `createAppContext(db, config)` factory that initializes all state [owner:api-engineer]
- [ ] [1.2] [P-2] Update `apps/agent/src/index.ts`: create AppContext at startup, pass to startServer(), pass to service start functions, use context in shutdown handler [owner:api-engineer]
- [ ] [1.3] [P-2] Update `apps/agent/src/server.ts`: accept AppContext parameter, pass to all route handlers, remove direct singleton imports [owner:api-engineer]
- [ ] [1.4] [P-2] Update all route files to accept AppContext: `routes/sessions.ts`, `routes/specs.ts`, `routes/analytics.ts`, `routes/project-detail.ts`, `routes/commands.ts`, `routes/events-sse.ts`, `routes/notifications.ts`, `routes/projects-discovered.ts`, `routes/health-history.ts`, `routes/agent-self.ts`, plus the 6 files from operational.ts split [owner:api-engineer]
- [ ] [1.5] [P-2] Update all services to accept AppContext: `services/socket-server.ts`, `services/cron.ts`, `services/spec-watcher.ts`, `services/peer-connector.ts`, `services/command-handler.ts`, `services/lifecycle-bus.ts` (if singleton), `services/federation-notify.ts` [owner:api-engineer]
- [ ] [1.6] [P-3] Fix memory leak singletons: add TTL (5 min) + max-size (1000) to notifications dedupMap, clear seenCanonicalPaths on each project discovery cycle, bind command-handler typeOverrides/projectRules to context lifecycle [owner:api-engineer]

## E2E Batch

- [ ] [2.1] Create `apps/agent/src/test-helpers/context.ts`: factory that creates a mock AppContext with in-memory stubs for db, config, and all services — used by all test files [owner:e2e-engineer]
- [ ] [2.2] Update existing tests to use mock context instead of importing singletons directly [owner:e2e-engineer]
- [ ] [2.3] Write tests for memory leak fixes: verify dedupMap respects TTL and max-size, verify seenCanonicalPaths clears on refresh [owner:e2e-engineer]
