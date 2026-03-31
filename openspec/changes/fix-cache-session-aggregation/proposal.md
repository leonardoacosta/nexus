# Proposal: Cache sorted sessions and project summaries

## Change ID
`fix-cache-session-aggregation`

## Summary
Cache the results of `all_sessions()` and `project_summaries()` in App state so the expensive clone+sort and BTreeMap aggregation run once per data update instead of 10+ times per render frame.

## Context
- Extends: `crates/nexus-tui/src/app.rs` — `all_sessions` (line 766), `project_summaries` (line 790), `update_agents` (line 1115)
- Related: none (no prior specs)

## Motivation
`all_sessions()` clones every `Session` and agent name `String`, collects into a `Vec<SessionRow>`, and sorts O(n log n) — called 10+ times per frame from dashboard rendering, status bar, palette, key handlers, and `update_agents` itself. `project_summaries()` performs a similar BTreeMap aggregation called 3+ times per frame. With 50 sessions across 5 agents, this produces hundreds of unnecessary allocations and sorts every ~16ms frame. Caching these derived views and invalidating only when `update_agents` brings new data eliminates the redundant work.

## Requirements
### Req-1: Cached session list
App SHALL maintain a cached sorted `Vec<SessionRow>` that is recomputed only when agent data changes. All callers SHALL read from the cache via a `&[SessionRow]` borrow instead of allocating a fresh Vec.

### Req-2: Cached project summaries
App SHALL maintain a cached `Vec<ProjectSummary>` that is recomputed only when agent data changes. All callers SHALL read from the cache via a `&[ProjectSummary]` borrow instead of allocating a fresh Vec.

## Scope
- **IN**: `all_sessions`, `project_summaries`, `update_agents`, and all call sites that invoke these methods
- **OUT**: Health history aggregation, other App state, rendering logic beyond switching to cached references

## Impact
| Area | Change |
|------|--------|
| `crates/nexus-tui/src/app.rs` | Add cached fields to App struct, invalidate in `update_agents`, expose `&[T]` accessors |
| `crates/nexus-tui/src/main.rs` | Update call sites from `app.all_sessions()` to `app.cached_sessions()` |
| `crates/nexus-tui/src/screens/dashboard.rs` | Update call site |
| `crates/nexus-tui/src/screens/projects.rs` | Update call sites |

## Risks
| Risk | Mitigation |
|------|-----------|
| Stale cache if sessions change outside `update_agents` | Audit all mutation paths; `update_agents` is the only entry point for new session data |
| Increased memory from cached copies | One extra copy vs 10+ per frame — net memory reduction |
