# Implementation Tasks

<!-- beads:epic:nx-045 -->

## Core Batch

- [x] [1.1] [P-1] Add `pub fn all(&self) -> Vec<ProjectPath>` method to `ProjectRegistry` in `crates/nexus-core/src/project_registry.rs` [owner:engineer]
- [x] [1.2] [P-1] Add `SpecSnapshot` struct to nexus-core: `{ name, status, completed_tasks, total_tasks, last_modified }` for change detection [owner:engineer]
- [x] [1.3] [P-2] Add unit test for `ProjectRegistry::all()` [owner:engineer]

## Service Batch

- [x] [3.1] [P-1] Create `crates/nexus-agent/src/services/spec_watcher.rs` implementing `Service` trait with 60s poll loop [owner:engineer]
- [x] [3.2] [P-1] Implement project enumeration — call `ProjectRegistry::all()`, filter to projects with `openspec/` directory [owner:engineer]
- [x] [3.3] [P-1] Implement polling — run `openspec list --json` per project via `tokio::process::Command`, parse into `Vec<SpecSnapshot>` [owner:engineer]
- [x] [3.4] [P-2] Implement staggered batching — poll 3-5 projects per tick with 200ms delay between batches [owner:engineer]
- [x] [3.5] [P-2] Implement change detection — diff current `HashMap<String, Vec<SpecSnapshot>>` against previous snapshot, detect new/removed/progress/complete transitions [owner:engineer]
- [x] [3.6] [P-2] Implement TTS notification emission — format messages per event type, coalesce within 5s window, send via existing notification path [owner:engineer]
- [x] [3.7] [P-2] Warm `ProjectStatusCache` with poll results — call `cache.set(code, status)` after each project poll [owner:engineer]
- [x] [3.8] [P-2] Wire `SpecWatcherService` into `main.rs` — construct, pass shared deps (registry, cache, notification sender), add to shutdown coordinator [owner:engineer]

## API Batch

- [x] [4.1] [P-1] Add `AllSpecsResponse` type to `http_handlers.rs` — `Vec<ProjectSpecStatus>` where each entry has code, name, specs array, beads summary [owner:engineer]
- [x] [4.2] [P-1] Implement `specs_all_handler` — read from ProjectStatusCache for all projects via `ProjectRegistry::all()` [owner:engineer]
- [x] [4.3] [P-2] Register `GET /specs/all` route in `main.rs` [owner:engineer]
- [x] [4.4] [P-2] Add unit test — verify response shape with mock cache data [owner:engineer]

## MCP Batch

- [x] [5.1] [P-1] Add `get_all_specs` tool definition to `tools/list` response in `crates/nexus-mcp/src/main.rs` [owner:engineer]
- [x] [5.2] [P-1] Implement `get_all_specs` handler — HTTP GET to `/specs/all`, format as MCP tool result [owner:engineer]
- [x] [5.3] [P-2] Handle agent unreachable error with clear MCP error message [owner:engineer]

## Verification Batch

- [x] [6.1] Verify `cargo build` succeeds for all workspace crates [owner:engineer]
- [x] [6.2] Verify `cargo test` passes with new ProjectRegistry::all() and SpecSnapshot tests [owner:engineer]
- [x] [6.3] Verify `cargo clippy` reports no new warnings [owner:engineer]
