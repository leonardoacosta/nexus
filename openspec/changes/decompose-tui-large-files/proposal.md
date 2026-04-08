# Proposal: TUI Large File Decomposition

## Change ID
`decompose-tui-large-files`

## Summary
Extract type modules from app.rs (1816 lines, 23 pub types), split render_stream (~650 lines) into widget builders, split process_project_specs (~187 lines) into per-event handlers, and clean up stale dead-code annotations and truly dead code across 5 Rust files.

## Context
- Extends: `crates/nexus-tui/src/app.rs`, `crates/nexus-tui/src/screens/stream.rs`, `crates/nexus-agent/src/services/spec_watcher.rs`, `crates/nexus-tui/src/client.rs`, `crates/nexus-agent/src/services/credential_pool.rs`
- Related: audit wave findings (P3 architecture), `decompose-delivery-service` (similar decomposition pattern, different target)

## Motivation
Five files exceed reasonable size/complexity thresholds identified during code audit. app.rs mixes 23 public types with full App state management, render_stream packs ~650 lines of layout logic into one function, process_project_specs handles 4 distinct event types in a single match block, and two files carry dead-code annotations that are either stale (callers exist now) or truly dead. Decomposing these improves navigability, testability, and reduces merge conflict surface.

## Requirements

### Req-1: Extract type modules from app.rs
Move the 23 pub types/enums (SearchState, CodeBlockRange, SessionTab, StreamVerbosity, LineStyle, StyledLine, StreamLine, Screen, InputMode, PaletteAction, PaletteEntry, AgentData, SessionRow, AgentOfflineRow, ActivityStatus, SyncStatus, ProjectSummary, AgentHealthHistory, ProjectDetail, SpecListEntry, SpecDetailState, ConfirmKind) into domain-grouped submodules under `crates/nexus-tui/src/types/`. Keep the `App` struct and its impl blocks in app.rs. Re-export all types from `types/mod.rs` so existing imports continue to work.

### Req-2: Split render_stream into widget builders
Extract the ~650-line `render_stream` function into smaller composable functions/modules under `crates/nexus-tui/src/screens/stream/`. Each widget builder handles one logical section of the stream layout. The top-level `render_stream` becomes a coordinator that calls the builders.

### Req-3: Split process_project_specs into per-event handlers
Extract the 4 event-type branches (hash change detection, task progress detection, new spec insertion, spec removal detection) from `process_project_specs` into dedicated helper functions in the same file. The main function becomes a dispatcher that calls each handler.

### Req-4: Clean up dead code annotations and remove truly dead code
- Remove `#[allow(dead_code)]` from 6 methods in `client.rs` (lines 314, 506, 551, 585, 637, 699) — all have active callers in main.rs and stream.rs.
- Remove `rename_pool_credential` function from `credential_pool.rs` (line 958) — zero callers anywhere in the codebase.

## Scope
- **IN**: Type extraction from app.rs, render_stream decomposition, process_project_specs decomposition, dead-code annotation cleanup, truly dead code removal
- **OUT**: Functional changes, new features, API changes, test additions (this is pure refactoring), decomposition of other large files not listed

## Impact
| Area | Change |
|------|--------|
| nexus-tui/src/app.rs | Shrinks from ~1816 to ~400-500 lines; types move to types/ submodules |
| nexus-tui/src/types/ | New module directory with domain-grouped type files |
| nexus-tui/src/screens/stream.rs | Becomes stream/ directory with coordinator + widget builders |
| nexus-agent/src/services/spec_watcher.rs | ~4 new helper functions extracted, main function shrinks to dispatcher |
| nexus-tui/src/client.rs | 6 stale `#[allow(dead_code)]` annotations removed |
| nexus-agent/src/services/credential_pool.rs | ~40 lines removed (dead `rename_pool_credential` function) |

## Risks
| Risk | Mitigation |
|------|-----------|
| Import path breakage after type extraction | Re-export everything from types/mod.rs; grep for all import sites and update |
| render_stream widget builders need mutable App access | Pass &mut App or relevant sub-state to each builder; keep signature simple |
| Merge conflicts with concurrent TUI work | No active TUI specs in progress; 4 active specs are unrelated domains |
