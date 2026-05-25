<!-- beads:epic:nx-bk767 -->
<!-- beads:feature:nx-volpd -->

# Tasks: agent-route-hardening

## DB Batch

## API Batch

- [ ] [1.1] [deferred] Fix `readProcessCwd` to resolve legacy empty-cwd rows via a `/proc/<pid>/cwd` readlink fallback [owner:api-engineer] [type:api] [beads:nx-cvyxt] (STALE PREMISE: /proc readlink blocked by nx-9jz0v; needs re-scope)
- [x] [1.2] Make the projects-discovered route return HTTP 500 (not 200) when `readdirSync` throws [owner:api-engineer] [type:api] [beads:nx-kkpc]

## UI Batch

## E2E Batch

- [x] [2.1] Regression tests: readdir failure yields HTTP 500 [owner:e2e-engineer] [type:testing] (readdir-500 half done; the "legacy empty-cwd resolves a real cwd" half is DEFERRED with task 1.1/nx-cvyxt — stale premise blocked by invariant nx-9jz0v)
