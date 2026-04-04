# Implementation Tasks

<!-- beads:epic:nx-1tut -->

## DB Batch

- [x] [1.1] [P-1] Create `packages/db/src/schema/agents.ts` — `agents` pgTable with columns: id(text PK=hostname), name, host, port(integer default 7400), projectsDir(text default ''), enabled(boolean default true), lastSeen(timestamp nullable), createdAt(timestamp defaultNow) [owner:db-engineer] [beads:nx-mwh9]
- [x] [1.2] [P-1] Export `agents` from `packages/db/src/schema/index.ts` and re-export from `packages/db/src/index.ts` [owner:db-engineer] [beads:nx-vtfl]
- [x] [1.3] [P-2] Run `pnpm db:generate` in `packages/db` to produce migration SQL [owner:db-engineer] [beads:nx-10f2]

## API Batch

- [x] [2.1] [P-1] Create `apps/agent/src/routes/agent-self.ts` — `handleGetAgentSelf(db)` queries `agents` by `os.hostname()`, returns 200 JSON row or 404 [owner:api-engineer] [beads:nx-bhch]
- [x] [2.2] [P-1] Create `apps/agent/src/routes/projects-discovered.ts` — `handleGetDiscoveredProjects(db)` reads agent row for projectsDir, does 1-level `.git` scan, cross-refs sessions table, returns `DiscoveredProjectsResponse` (truncate at 100) [owner:api-engineer] [beads:nx-78sm]
- [x] [2.3] [P-1] Create `apps/agent/src/db/agent-registry.ts` — `upsertSelfInRegistry(db)` startup upsert: insert hostname row with host(try tailscale ip), port, projectsDir(from env NEXUS_PROJECTS_DIR ?? HOME/dev), onConflict update host+port+lastSeen only (NOT projectsDir) [owner:api-engineer] [beads:nx-ekqp]
- [x] [2.4] [P-2] Register `GET /agent/self` and `GET /projects/discovered` routes in `apps/agent/src/server.ts` [owner:api-engineer] [beads:nx-ow1t]
- [x] [2.5] [P-2] Call `upsertSelfInRegistry(db)` in `apps/agent/src/index.ts` after `openDatabase()` succeeds — wrap in try/catch, warn on failure, do not abort startup [owner:api-engineer] [beads:nx-028u]

## UI Batch

- [x] [3.1] [P-1] Rewrite `apps/nextjs/src/lib/get-client.ts` — replace `readFileSync(dashboard.json)` with `db.select().from(agents).where(eq(agents.enabled, true))`; make `getAgentConfigs()` async; preserve localhost:7400 fallback when table is empty [owner:ui-engineer] [beads:nx-cqh6]
- [x] [3.2] [P-1] Rewrite `saveAgentConfig()` in `apps/nextjs/src/app/actions/settings.ts` — replace `writeFileSync`/`mkdirSync`/`readFileSync` with `db.insert(agents).onConflictDoUpdate` (add) and `db.delete(agents)` (remove); remove `resetClient()` call [owner:ui-engineer] [beads:nx-rn0i]
- [x] [3.3] [P-2] Remove `resetClient()` from `apps/nextjs/src/lib/get-client.ts` export and all callers; `getClient()` no longer needs singleton invalidation [owner:ui-engineer] [beads:nx-rh6c]

## Cleanup Batch

- [x] [4.1] [P-1] Remove `Environment=NEXUS_PROJECTS_DIR=%h/dev` line from `deploy/nexus-agent.service` [owner:api-engineer] [beads:nx-bomo]
- [x] [4.2] [P-1] Remove `agents.toml` seeding block (lines referencing agents.toml) from `deploy/install.sh` [owner:api-engineer] [beads:nx-k7ax]
- [x] [4.3] [P-2] Add `pnpm --filter @nexus/db db:migrate` step to `deploy/hooks.d/pre-push/01-deploy` before `systemctl --user start nexus-agent` [owner:api-engineer] [beads:nx-e9pu]

## E2E Batch

- [x] [5.1] Add unit test for `upsertSelfInRegistry` — mock db, verify upsert called with hostname [owner:test-writer] [beads:nx-1ri4]
- [x] [5.2] Add unit test for `handleGetDiscoveredProjects` — mock fs with 3 git dirs + 1 non-git dir, verify response shape and session cross-reference [owner:test-writer] [beads:nx-kwws]
- [x] [5.3] Add unit test for `get-client.ts` — mock db returning 2 agents, verify AgentClient constructed with both; mock db returning empty, verify localhost fallback [owner:test-writer] [beads:nx-zrxr]
