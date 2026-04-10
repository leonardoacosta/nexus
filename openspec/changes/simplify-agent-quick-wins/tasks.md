# Implementation Tasks

<!-- beads:epic:nx-mu5z -->

## API Batch

- [x] [1.1] [P-1] Create `apps/agent/src/utils/exec.ts`: typed `execJson<T>(cmd, args, opts?)` and `execText(cmd, args, opts?)` helpers — stdout capture via Bun.spawn, configurable timeout (default 10s), JSON parse with error wrapping, cwd option, proper cleanup on timeout [owner:api-engineer]
- [x] [1.2] [P-1] Create `apps/agent/src/services/config-loader.ts`: singleton that loads `projects.json` and `settings.json` once at startup, watches with `fs.watch` (500ms debounce) for changes, provides `getProjects()` and `getSettings()` methods returning cached data [owner:api-engineer]
- [x] [1.3] [P-2] Replace all 9 Bun.spawn call sites with execJson/execText: `routes/specs.ts` (openspec, bd), `routes/project-detail.ts` (bd, git, openspec), `routes/sessions.ts` (tmux), `routes/operational.ts` (git, bd, gh), `services/cron.ts` (git), `services/spec-watcher.ts` (openspec) [owner:api-engineer]
- [x] [1.4] [P-2] Replace readFileSync config reads with config-loader: `routes/project-detail.ts` (projects.json per-request), `routes/operational.ts` (settings.json per-request), `services/cron.ts` (settings.json per-tick) [owner:api-engineer]
- [x] [1.5] [P-3] Split `routes/operational.ts` (683L) into 6 files: `routes/statusline.ts`, `routes/hooks.ts`, `routes/recommend.ts`, `routes/environment-route.ts`, `routes/failures-route.ts`, `routes/cron-routes.ts` — move each handler + its helpers, delete operational.ts [owner:api-engineer]
- [x] [1.6] [P-3] Update `apps/agent/src/server.ts`: replace operational.ts imports with 6 new route file imports, register handlers at same paths, verify all endpoints respond [owner:api-engineer]

## E2E Batch

- [x] [2.1] Write unit tests for `utils/exec.ts`: test execJson with mock subprocess, test timeout behavior, test non-zero exit code error, test invalid JSON error [owner:e2e-engineer]
- [x] [2.2] Write unit tests for `services/config-loader.ts`: test initial load, test cache hit (no re-read), test file change triggers reload [owner:e2e-engineer]
- [x] [2.3] Write basic tests for each split route file: verify handler exports, verify response shape for statusline, hooks, recommend, environment, failures, cron [owner:e2e-engineer]
