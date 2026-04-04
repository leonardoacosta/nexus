## 1. Proto (DB batch)

- [ ] 1.1 Add `ListProjectsRequest` (empty message) and `ListProjectsResponse` (repeated string `projects`) to `proto/nexus.proto`
- [ ] 1.2 Add `ListProjects(ListProjectsRequest) returns (ListProjectsResponse)` RPC to the `NexusAgent` service
- [ ] 1.3 Run `cargo build` to regenerate protobuf code and verify compilation

## 2. Agent Implementation (API batch)

- [ ] 2.1 Implement `list_projects` handler in `crates/nexus-agent/src/grpc.rs`: scan `~/.claude/projects/`, extract project names from directory names (last segment after `-dev-`), deduplicate, sort, return
- [ ] 2.2 Handle edge cases: directory does not exist (return empty), permission errors (log warning, return empty), hidden directories (skip entries starting with `.`)
- [ ] 2.3 Verify with `cargo build -p nexus-agent` and `cargo clippy -p nexus-agent`

## 3. TUI Implementation (UI batch)

- [ ] 3.1 Add `list_projects` method to `crates/nexus-tui/src/client.rs` that calls the `ListProjects` RPC on a specific agent
- [ ] 3.2 Replace `InputMode::StartSessionProject` with `InputMode::StartSessionProjectSelect` in `crates/nexus-tui/src/app.rs`
- [ ] 3.3 Add project list state to `App`: `start_projects: Vec<String>`, `start_project_idx: usize`, `start_project_filter: String`
- [ ] 3.4 Implement `render_project_select` in `crates/nexus-tui/src/screens/palette.rs` (same visual pattern as `render_agent_select` with type-ahead filter display)
- [ ] 3.5 Update `render_start_session` to dispatch to `render_project_select` for `StartSessionProjectSelect` mode
- [ ] 3.6 Add `handle_project_select_key` in `crates/nexus-tui/src/main.rs`: j/k navigation, Enter to select (set `start_project`, auto-fill `start_cwd`, advance to `StartSessionCwd`), Esc to cancel, char input for type-ahead filter, Backspace to remove filter char
- [ ] 3.7 Wire `handle_project_select_key` into the `handle_key` match in `main.rs`
- [ ] 3.8 Add `ListProjects` RPC command variant to `RpcCommand` enum and handle it in `background_task`
- [ ] 3.9 Add `RpcResult::ProjectList(Vec<String>)` variant and handle it in the event loop to populate `app.start_projects`
- [ ] 3.10 Update `begin_start_session` to trigger `ListProjects` RPC when transitioning to project select step
- [ ] 3.11 Update all references to `StartSessionProject` throughout `main.rs` and `palette.rs` to use the new variant

## 4. Verification (E2E batch)

- [ ] 4.1 `cargo build` compiles the full workspace without errors
- [ ] 4.2 `cargo clippy` passes for all crates
- [ ] 4.3 `cargo fmt --check` passes
- [ ] 4.4 `cargo test` passes (if any tests exist)
- [ ] 4.5 Manual test: run agent, run TUI, press `n`, verify project list appears with projects from `~/.claude/projects/`
- [ ] 4.6 Manual test: type characters to filter the project list, verify filtering works
- [ ] 4.7 Manual test: select a project, verify cwd auto-fills to `~/dev/<project>`
- [ ] 4.8 Manual test: verify Esc cancels the wizard at the project select step
