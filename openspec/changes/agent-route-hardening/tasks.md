<!-- beads:epic:nx-bk767 -->
<!-- beads:feature:nx-volpd -->

# Tasks: agent-route-hardening

## DB Batch

## API Batch

- [ ] [1.1] Fix `readProcessCwd` to resolve legacy empty-cwd rows via a `/proc/<pid>/cwd` readlink fallback [owner:api-engineer] [type:api] [beads:nx-cvyxt]
- [x] [1.2] Make the projects-discovered route return HTTP 500 (not 200) when `readdirSync` throws [owner:api-engineer] [type:api] [beads:nx-kkpc]

## UI Batch

## E2E Batch

- [ ] [2.1] Regression tests: legacy empty-cwd row resolves a real cwd; readdir failure yields HTTP 500 [owner:e2e-engineer] [type:testing]
