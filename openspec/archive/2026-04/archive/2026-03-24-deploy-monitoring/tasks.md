## 1. Proto Changes
- [ ] 1.1 Add `SyncStatus` enum to nexus.proto: UNSPECIFIED, SYNCED, BEHIND, AHEAD, DIVERGED, UNKNOWN
- [ ] 1.2 Add `ProjectInfo` message: name, path, git_branch, last_commit_hash, last_commit_time, sync_status, commits_behind (optional int32)
- [ ] 1.3 Change `ListProjectsResponse` from `repeated string projects` to `repeated ProjectInfo projects` — ensure backward compat by keeping field number
- [ ] 1.4 Run proto codegen (`cargo build -p nexus-core`) to generate Rust types

## 2. Agent Implementation
- [ ] 2.1 In `list_projects` handler (grpc.rs ~lines 842-904), resolve project paths from `~/.claude/projects/` scan
- [ ] 2.2 For each project path, run `git -C <path> rev-parse --abbrev-ref HEAD` to get branch
- [ ] 2.3 Run `git -C <path> log -1 --format=%H,%ct` to get latest commit hash and timestamp
- [ ] 2.4 Run `git -C <path> rev-list HEAD..@{u} --count 2>/dev/null` to get commits behind (0 = synced)
- [ ] 2.5 Map git results to SyncStatus enum (0 behind = SYNCED, >0 = BEHIND, no upstream = UNKNOWN)
- [ ] 2.6 Return enriched `ProjectInfo` in `ListProjectsResponse`

## 3. TUI Display
- [ ] 3.1 Extend `ProjectSummary` in app.rs with fields: `sync_status`, `commits_behind`, `git_branch`, `last_commit`
- [ ] 3.2 Update `update_projects()` aggregation to populate sync fields from enriched ListProjects response
- [ ] 3.3 Add sync status column to projects.rs table: dot indicator (green=synced, yellow=behind, gray=unknown)
- [ ] 3.4 Show "N behind" text next to project name when commits_behind > 0
- [ ] 3.5 Update client.rs `list_projects()` to parse enriched ProjectInfo response

## 4. Validation
- [ ] 4.1 `cargo build` — all crates compile (proto codegen + agent + TUI)
- [ ] 4.2 `cargo test` — all tests pass
- [ ] 4.3 Manual smoke: deploy agent, launch TUI, verify sync status shows for at least one project
