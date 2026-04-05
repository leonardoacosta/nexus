## Batch 1: API — TypeScript route fixes (apps/agent)

- [x] 1.1 Import `DiscoveredProjectsResponse` from `@nexus/core` in `projects-discovered.ts`; remove the local interface definition (Req-1, nx-0frb)
- [x] 1.2 Replace `{ projects, projectsDir, total }` return shape with `{ projects, truncated }` throughout `handleGetDiscoveredProjects` (Req-1, nx-0frb)
- [x] 1.3 Add tilde expansion helper: replace leading `~` with `os.homedir()` and call `path.resolve` before `readdirSync` (Req-2, nx-8v2a)
- [x] 1.4 Add absolute-path guard: if resolved `projectsDir` is not absolute after expansion, return `400` with `{ error: "projectsDir must resolve to an absolute path" }` (Req-2)
- [x] 1.5 Convert `readdirSync` catch block to return `{ error: err.message }` (status 200) instead of an empty projects list (Req-3, nx-bbd0)
- [x] 1.6 Add pino logger instance to `projects-discovered.ts`; emit `info` log with `{ route, durationMs, count, fromCache }` on each request; emit `error` log on readdirSync failure (Req-6, nx-zhzr)
- [x] 1.7 Add pino logger instance to `projects.ts`; emit `info` log with `{ route, durationMs, count, fromCache }` on each request (Req-6, nx-zhzr)

## Batch 2: UI — aggregation and deduplication in agent-client (apps/nextjs)

- [x] 2.1 Add optional `machineCount?: number` to `DiscoveredProject` in `packages/core/src/types/project.ts` (Req-5)
- [x] 2.2 Confirm `fetchDiscoveredProjects` in `agent-client.ts` uses `Promise.allSettled` — already present; verify no sequential fallback path remains (Req-4, nx-oeun)
- [x] 2.3 After `Promise.allSettled` resolves, build a dedup map keyed by `name+"|"+path`; merge entries by incrementing `machineCount` (Req-5, nx-abk1)
- [x] 2.4 Update `fetchAllProjects` similarly to use `Promise.allSettled` if any sequential code path exists (Req-4)
- [x] 2.5 Update `apps/nextjs/src/app/actions/projects.ts` sort comparator to handle the new `machineCount` field gracefully (no sort change required; ensure it compiles)

## Batch 3: E2E — route tests

- [x] 3.1 Write unit tests for the tilde expansion helper (valid tilde, relative path rejection) (Req-2, nx-jilp)
- [x] 3.2 Write tests for `handleGetDiscoveredProjects`: empty dir returns `{projects:[], truncated:false}`; readdirSync error returns `{error:...}`; 101 entries sets `truncated:true` (Req-1, Req-3, nx-jilp)
- [x] 3.3 Write test for deduplication: two agents reporting same project yields one entry with `machineCount===2` (Req-5, nx-jilp)
- [x] 3.4 Verify `GET /projects/discovered` log lines appear in test output (smoke-level log assertion) (Req-6)
- [x] 3.5 Run `pnpm typecheck` and `pnpm lint` — no new errors
