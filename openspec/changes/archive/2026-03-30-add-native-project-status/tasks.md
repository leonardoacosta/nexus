<!-- beads:epic:nexus-7bf -->

## 1. Core: Project Registry [beads:nexus-oly]

- [x] Create `crates/nexus-core/src/project_registry.rs`
  - Read `~/.claude/scripts/config/projects.json` to map project codes to paths
  - Fallback: scan `~/dev/<code>/` if not in registry
  - Hot-reload on file change (integrate with existing config watcher)
  - Expose `resolve(code: &str) -> Option<ProjectPath>` with `cwd`, `name`, `code`

## 2. Core: Status Collection Service [beads:nexus-ajp]

- [x] Create `crates/nexus-agent/src/services/project_status.rs`
  - `BeadsStatus`: run `bd ready --json` + `bd stats` in project cwd, parse JSON output
  - `GitStatus`: run `git -C <path> log --oneline -5`, `git -C <path> status --porcelain`,
    `git -C <path> branch --show-current`, `git -C <path> rev-parse --short HEAD`
  - `SpecStatus`: run `openspec list --json` in project cwd (or return empty if no openspec dir)
  - Each collector returns typed structs, handles subprocess failures gracefully (timeout 5s)

## 3. Core: Response Caching [beads:nexus-d7l]

- [x] Add per-project response cache with configurable TTL (default 30s)
  - Key: `(project_code, status_type)` — cache beads/git/specs independently
  - Use `tokio::sync::RwLock<HashMap>` with timestamp-based expiry
  - Cache invalidation on explicit request (query param `?fresh=true`)

## 4. Proto: New Messages and RPC [beads:nexus-8ai]

- [x] Add to `proto/nexus.proto`:
  - `ProjectStatusRequest { string project = 1; bool fresh = 2; }`
  - `ProjectStatusResponse` with nested `BeadsStatus`, `GitStatus`, `SpecStatus` messages
  - `BeadsStatus { int32 ready_count, int32 open_count, int32 blocked_count, string ready_json }`
  - `GitStatus { string branch, string head_sha, repeated string recent_commits, string porcelain }`
  - `SpecStatus { int32 spec_count, int32 change_count, repeated string active_changes }`
  - `GetProjectStatus` RPC on `NexusAgent` service

## 5. gRPC: Implement GetProjectStatus [beads:nexus-9k9]

- [x] Wire `GetProjectStatus` in `crates/nexus-agent/src/grpc.rs`
  - Resolve project code via registry
  - Collect all three status types (parallel tokio::join!)
  - Return cached or fresh based on request flag
  - Return `NOT_FOUND` if project code unknown

## 6. HTTP: Add Per-Project Endpoints [beads:nexus-loz]

- [x] Add routes to `crates/nexus-agent/src/main.rs`:
  - `GET /project/:code/status` — aggregated (beads + git + specs)
  - `GET /project/:code/beads` — beads only
  - `GET /project/:code/git` — git only
  - `GET /project/:code/specs` — openspec only
  - All support `?fresh=true` query param to bypass cache
  - JSON responses matching proto message structure

## 7. Integration: Wire into Agent Startup [beads:nexus-c4z]

- [x] Initialize `ProjectRegistry` in agent startup (load projects.json)
- [x] Initialize `ProjectStatusService` with registry + cache
- [x] Pass as shared state to HTTP router and gRPC service

## 8. Tests [beads:nexus-099]

- [x] Unit tests for project registry resolution (known code, unknown code, fallback)
- [x] Unit tests for status parsing (valid bd output, malformed output, timeout)
- [x] Integration test for gRPC `GetProjectStatus` RPC
- [x] Integration test for HTTP endpoints (200 for known project, 404 for unknown)
