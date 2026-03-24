## Summary

Add per-project deploy/sync monitoring across machines. Each agent tracks project git state (branch, latest commit, last sync timestamp). The TUI shows sync status indicators on the projects screen so users can see which machines are behind.

## Motivation

Projects can be deployed from any machine. Currently there's no visibility into whether a machine's copy is up to date. Users must SSH into each machine and check manually. This spec adds the data pipeline (proto → agent → TUI) to surface sync status.

## Approach

1. Add `ProjectDetail` and `SyncStatus` messages to nexus.proto (additive, backward compatible)
2. Agent collects git info (branch, HEAD commit, last push timestamp) for each discovered project
3. Extend `ListProjectsResponse` to include `ProjectInfo` with sync metadata
4. TUI displays sync status column on projects screen (synced/behind/unknown)
5. Show commit diff count ("3 behind") when machines are out of sync

## Files Modified

- `proto/nexus.proto` — add ProjectDetail, SyncStatus messages, extend ListProjectsResponse
- `crates/nexus-core/src/lib.rs` — re-export generated types
- `crates/nexus-agent/src/grpc.rs` — implement project detail collection (git status per project)
- `crates/nexus-tui/src/app.rs` — extend ProjectSummary with sync fields
- `crates/nexus-tui/src/screens/projects.rs` — add sync status column
- `crates/nexus-tui/src/client.rs` — update ListProjects call to use enriched response
