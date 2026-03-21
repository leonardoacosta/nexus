# Change: Project List for New Session Wizard

## Change ID

`project-list-wizard`

## Summary

Replace the free-text project input in the TUI's new session wizard with a selectable project list
sourced from `~/.claude/projects/`. The agent scans that directory via a new `ListProjects` gRPC
RPC, extracts project names, and returns a sorted, deduplicated list. The TUI renders a filterable
select widget (same pattern as agent-select) instead of the current text prompt.

## Context

The start session wizard (press `n` from Dashboard) currently asks the user to type a project name
into a free-text field. This is error-prone — users must remember exact project names and can
mistype them. Meanwhile, `~/.claude/projects/` already contains directories named after every
project Claude Code has seen on that machine, in the format `-home-user-dev-<project>`. This is a
reliable, zero-configuration source of known projects.

The TUI already has a proven list-selection widget (`render_agent_select` in
`crates/nexus-tui/src/screens/palette.rs`) that supports `j`/`k` navigation and Enter to confirm.
The project select reuses this exact pattern.

## Motivation

- **Discoverability**: Users see all projects available on the selected agent without memorizing names
- **Accuracy**: No typos — project names come from the filesystem
- **Speed**: Selecting from a list is faster than typing, especially for long project names
- **Consistency**: The wizard already uses a list for agent selection; project selection should match

## Requirements

1. **ListProjects RPC**: New unary gRPC RPC in the `NexusAgent` service. The agent scans
   `~/.claude/projects/`, extracts project names from directory names (format:
   `-home-user-dev-<project>`), deduplicates, and returns a sorted `ProjectList` message.
2. **TUI project selection**: Replace `render_text_prompt` for the `StartSessionProject` step with
   a `render_project_select` list widget (same visual pattern as `render_agent_select`). Supports
   `j`/`k` navigation, Enter to select, and type-ahead filtering as the user types.
3. **Cwd auto-fill**: When a project is selected from the list, auto-fill `start_cwd` to
   `~/dev/<project>` (existing behavior, now triggered from list selection instead of text input).
4. **New InputMode variant**: Add `StartSessionProjectSelect` to the `InputMode` enum to
   distinguish the new list-based selection from the old text input.

## Scope

**IN scope:**
- `ListProjects` RPC definition in `proto/nexus.proto`
- Agent-side directory scan implementation in `crates/nexus-agent/`
- TUI project select widget in `crates/nexus-tui/src/screens/palette.rs`
- App state changes for project list and selection index
- `InputMode` update and key handler wiring

**OUT of scope:**
- Project metadata beyond the name (no session counts, no last-used timestamp)
- Cross-machine project aggregation (each agent scans its own local filesystem)
- Caching or file-watching for the projects directory (scan on each wizard open)
- Fallback to free-text input if no projects found (show empty list with "no projects" message)

## Impact

- Affected proto: `proto/nexus.proto` — new `ListProjectsRequest`, `ListProjectsResponse`,
  `ProjectList` messages and `ListProjects` RPC
- Affected code:
  - `crates/nexus-agent/src/grpc.rs` — implement `ListProjects` handler
  - `crates/nexus-tui/src/app.rs` — new `InputMode::StartSessionProjectSelect`, project list state
  - `crates/nexus-tui/src/screens/palette.rs` — new `render_project_select` function
  - `crates/nexus-tui/src/main.rs` — new key handler, RPC command variant, background task handler
  - `crates/nexus-tui/src/client.rs` — new `list_projects` client method
- No breaking changes — purely additive
- Estimated ~150 LOC across all crates

## Risks

- **Empty projects directory**: If `~/.claude/projects/` does not exist or is empty, the list will
  be empty. Mitigation: show "no projects found" in the select widget; user can press Esc to cancel.
- **Directory name format variation**: Project directory names follow the pattern
  `-home-user-dev-<project>` but the path prefix varies by machine. Mitigation: extract the last
  path segment after the final `-dev-` (or last segment if no `-dev-` found).
- **Large number of projects**: A user with many projects could produce a long list. Mitigation:
  type-ahead filtering narrows the list as the user types, and the list scrolls.
