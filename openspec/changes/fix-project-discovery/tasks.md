## 1. Agent Route — Wire Format Fix (P1)

- [x] 1.1 Replace `hasActiveSessions: boolean` with `activeSessions: number` and
      `totalSessions: number` in `AgentDiscoveredProject` interface
      (`apps/agent/src/routes/projects-discovered.ts:27-31`)
- [x] 1.2 Update route handler to count active sessions (sessions with `status = "active"` or
      `last_seen` within 5 min) and total sessions from `recentSessions` result set
- [x] 1.3 Populate `activeSessions` and `totalSessions` on each `AgentDiscoveredProject` entry
      before pushing to the `projects` array
- [x] 1.4 Update `AgentDiscoveredProjectsResponse` if field names or types changed; ensure
      TypeScript compiles cleanly (`bun run typecheck`)

## 2. Tilde Expansion — Guard All Call Sites (P1)

- [x] 2.1 Audit every location that reads `agent.projectsDir` from the DB; confirm
      `expandProjectsDir` is called before any FS operation
- [x] 2.2 Add a unit test for `expandProjectsDir` covering: plain `~/dev`, `~` only,
      `/absolute/path` unchanged, relative path without `~` unchanged
- [x] 2.3 Add integration test: agent row with `projects_dir = "~/dev"` must scan successfully
      (no ENOENT) when `os.homedir()` is mocked

## 3. Next.js Client — Count Mapping Fix (P1)

- [x] 3.1 Remove `project.hasActiveSessions ? 1 : 0` expression from `fetchDiscoveredProjects`
      (`apps/nextjs/src/lib/agent-client.ts:190`)
- [x] 3.2 Map `activeSessions` → `active_sessions` and `totalSessions` → `total_sessions` from
      the wire type to `DiscoveredProject`
- [x] 3.3 When dedup merges a duplicate, accumulate `active_sessions` and `total_sessions`
      across agents rather than ignoring the second entry's counts
- [x] 3.4 Update local type alias `AgentDiscoveredResponse` (or equivalent) to match the new
      wire format

## 4. Dedup Key — Normalized Path (P2)

- [x] 4.1 Replace dedup key `${project.name}|${project.path}` with normalized absolute path:
      resolve symlinks via `fs.realpathSync` (or equivalent), lowercase on macOS/case-insensitive
      FS, uppercase-preserve on Linux
- [ ] 4.2 Attempt to read git remote URL from `git remote get-url origin` for each project
      (timeout 500 ms); use as the canonical cross-machine identity key when available, fall back
      to normalized path
- [x] 4.3 On dedup hit, accumulate counts (step 3.3) and do NOT overwrite the `agent` field
      (keep the first-reporter's agent name)
- [ ] 4.4 Write unit tests covering: same project on two agents with different home dirs
      (same git remote → single entry), path with symlink (resolves to same canonical), macOS
      lowercase collision

## 5. Stale Project Eviction (P2)

- [x] 5.1 Add `lastSeenAt: number` (Unix ms timestamp) to the aggregated discovered project
      entry (client-side, not wire format)
- [x] 5.2 On each `fetchDiscoveredProjects` call, remove entries whose `lastSeenAt` is older
      than 1 hour before merging new results
- [ ] 5.3 Add unit test: project not returned by any agent for 61 minutes is excluded from
      aggregated result

## 6. Path Normalization — Symlink Dedup (P2)

- [x] 6.1 In route handler, resolve symlinks via `fs.realpathSync` before inserting into
      `projects` array; if resolution fails (broken symlink) skip the entry and log a warning
- [x] 6.2 Skip entries that already exist at the resolved path (guards against `link → real`
      creating two entries)
- [ ] 6.3 Add scenario test: directory containing a symlink that points to another project in
      the same `projectsDir` — only the canonical path appears once

## 7. Path-to-Registry Mapping (P2)

- [ ] 7.1 In the route handler response, include `registryId: string | null` — query the
      `projects` DB table for a row whose `path` matches the resolved project path; `null` if
      not found
- [ ] 7.2 Extend `AgentDiscoveredProject` interface with `registryId: string | null`
- [ ] 7.3 Extend `DiscoveredProject` core type with `registryId: string | null`
- [ ] 7.4 Update Next.js client mapping to pass `registryId` through

## 8. Cross-Agent Metadata Alignment (P2)

- [x] 8.1 Confirm `agent` field is set only on first-seen entry (step 4.3 covers this)
- [x] 8.2 When a project appears on multiple agents, surface `machineCount` to the UI layer
      (already tracked — ensure it is not dropped before the component receives it)

## 9. Cache Freshness Header (P3)

- [x] 9.1 Add `X-Cache-Age: <ms>` response header to `GET /projects/discovered` indicating age
      of cached data (0 when freshly computed)
- [x] 9.2 Add `X-Cache-TTL: <ms>` response header with configured TTL value

## 10. Empty projectsDir Feedback (P3)

- [x] 10.1 When `rawProjectsDir` is empty after trim, log at `info` level with a clear message:
      `"projectsDir not configured for agent <id> — returning empty project list"`
- [x] 10.2 Include `configured: false` field in the response body when `projectsDir` is
      unconfigured (additive, non-breaking)

## 11. Input Validation (P3)

- [x] 11.1 Reject `projectsDir` values containing `..` path segments after expansion (return
      `400` with descriptive error)
- [x] 11.2 Reject empty string after trim (handled by step 10.2, return empty list — do not
      error)
- [x] 11.3 Add validation unit tests for traversal attempt and valid deep path

## 12. Query Window Consistency (P3)

- [ ] 12.1 Expose `queryWindowHours` as a configurable constant (default 24) used by all agents
      in `queryRecentSessions`; document in agent config schema
- [ ] 12.2 Confirm all agents use the same default window and log the value at startup

## 13. Verification

- [x] 13.1 `bun run typecheck` passes with zero errors across all packages
- [x] 13.2 `bun run lint` passes with zero warnings on changed files
- [x] 13.3 All new unit tests pass: `bun test --filter projects-discovered`
- [ ] 13.4 Manual smoke test: `curl http://localhost:7400/projects/discovered | jq` returns
      entries with numeric `activeSessions` and `totalSessions`
