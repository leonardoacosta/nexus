# Implementation Tasks

<!-- beads:epic:nx-drmt -->

## API Batch

- [ ] [1.1] [P-1] Create `apps/agent/src/routes/specs.ts`: implement GET /specs/all, GET /specs, GET /specs/{project}/{name}, PUT /specs/{project}/{name}, POST /specs/{project}/{name}/read, GET /specs/{project}/{name}/status — all delegating to `Bun.spawn('openspec', ...)` with JSON parsing [owner:api-engineer]
- [ ] [1.2] [P-1] Create `apps/agent/src/routes/analytics.ts`: implement GET /analytics/health, /analytics/specs, /analytics/credentials, /analytics/git, /analytics/lifecycle, /analytics/cron — query Postgres for time-series data (health_snapshots, credential_polls, session_events) [owner:api-engineer]
- [ ] [1.3] [P-1] Create `apps/agent/src/routes/project-detail.ts`: implement GET /project/{code}/status, /project/{code}/beads, /project/{code}/git, /project/{code}/specs, POST /project/{code}/run — shell out to bd/git/openspec per project cwd from projects registry [owner:api-engineer]
- [ ] [1.4] [P-1] Create `apps/agent/src/routes/commands.ts`: implement GET /commands (list all), GET /commands/{name} (list by namespace), PUT /commands/{name} (update command content) with in-memory CommandRegistry service [owner:api-engineer]
- [ ] [1.5] [P-1] Create `apps/agent/src/routes/operational.ts`: implement GET /statusline, POST /hooks, GET /recommend, GET /environment, GET /failures, GET /cron — thin handlers reading from in-memory caches and service state [owner:api-engineer]
- [ ] [1.6] [P-2] Create `apps/agent/src/routes/events-sse.ts`: implement GET /events as Server-Sent Events stream — subscribe to session lifecycle, spec changes, and notification events via internal event bus, push as SSE frames [owner:api-engineer]
- [ ] [1.7] [P-2] Create `apps/agent/src/services/command-registry.ts`: in-memory registry of project commands (loaded from filesystem on startup), supports list/filter/update operations [owner:api-engineer]
- [ ] [1.8] [P-2] Create `apps/agent/src/services/environment-cache.ts`: cache of project environment variables and config, refreshed on project discovery [owner:api-engineer]
- [ ] [1.9] [P-2] Create `apps/agent/src/services/failure-buffer.ts`: ring buffer of recent failures (errors, panics, gate failures) with TTL-based eviction [owner:api-engineer]
- [ ] [1.10] [P-2] Wire POST /session/start into existing terminal management — spawn tmux window via `Bun.spawn('tmux', ['new-window', ...])` and send-keys for claude, reusing PTY infrastructure from `apps/agent/src/terminal/` [owner:api-engineer]
- [ ] [1.11] [P-3] Register all new routes in `apps/agent/src/server.ts`, add X-Nexus-Secret auth middleware for protected routes, ensure consistent error response format [owner:api-engineer]

## E2E Batch

- [ ] [2.1] Write integration tests for spec routes: mock openspec subprocess output, verify JSON response shape matches Rust agent contract [owner:e2e-engineer]
- [ ] [2.2] Write integration tests for analytics routes: seed Postgres with test data, verify time-series aggregation and query params (hours, project filter) [owner:e2e-engineer]
- [ ] [2.3] Write integration tests for project detail routes: mock bd/git subprocess output, verify enriched project status response [owner:e2e-engineer]
- [ ] [2.4] Write SSE integration test: connect to /events, trigger a session start, verify SSE frame received within 1s [owner:e2e-engineer]
