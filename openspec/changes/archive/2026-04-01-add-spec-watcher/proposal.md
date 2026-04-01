# Proposal: Proactive Spec Watcher Service

## Change ID
`add-spec-watcher`

## Summary
A new agent service that proactively polls openspec + beads status across all registered projects,
detects changes, emits TTS notifications, warms the ProjectStatusCache, and exposes a cross-project
aggregate endpoint with a matching MCP tool.

## Context
- Extends: `crates/nexus-agent/src/services/` (new service), `crates/nexus-agent/src/http_handlers.rs` (new endpoint), `crates/nexus-mcp/src/main.rs` (new tool)
- Related: `project_status.rs` (existing collectors), `git_watch.rs` (polling service pattern), `credential_pool.rs` (service wiring pattern)

## Motivation
Currently spec and beads status is only collected on-demand when an HTTP request hits
`/project/:code/specs`. This means the TUI dashboard shows stale data until polled, and there are
no proactive notifications when specs change state. With 15+ projects, knowing when a spec completes
or when new work appears requires manual checking. A proactive watcher fills the cache for all
projects, detects state transitions, and notifies via TTS — so Leo always knows what's happening
across the fleet without polling manually.

## Requirements

### Req-1: Proactive polling service
The agent MUST run a background service that polls openspec + beads status for every registered
project every 60 seconds, using the existing `collect_spec_status` and `collect_beads_status`
collectors from `project_status.rs`.

### Req-2: Change detection with TTS notifications
The service MUST detect state transitions and emit TTS notifications for: new spec created,
task completion progress, all-tasks-complete (ready to archive), and spec archived.

### Req-3: Cross-project aggregate endpoint
The agent MUST expose `GET /specs/all` returning aggregated spec + beads status for every project
in a single JSON response, powered by the proactively-warmed cache.

### Req-4: MCP tool for cross-project spec status
The `nexus-mcp` binary MUST expose a `get_all_specs` tool that proxies `GET /specs/all` for
AI assistant consumption.

### Req-5: ProjectRegistry iteration
`ProjectRegistry` MUST expose an `all()` method returning all registered projects for the
watcher to enumerate.

## Scope
- **IN**: Polling service, change detection, TTS notifications (all events), ProjectStatusCache warming, GET /specs/all endpoint, get_all_specs MCP tool, ProjectRegistry.all()
- **OUT**: Filesystem inotify watching (polling is sufficient), per-spec detail endpoint (already exists at /project/:code/specs), beads issue creation/mutation, TUI spec dashboard view

## Impact
| Area | Change |
|------|--------|
| nexus-core/project_registry.rs | Add `all()` method |
| nexus-agent/services/ | New `spec_watcher.rs` service |
| nexus-agent/http_handlers.rs | New `GET /specs/all` endpoint |
| nexus-agent/main.rs | Wire SpecWatcherService |
| nexus-mcp/main.rs | New `get_all_specs` tool |

## Risks
| Risk | Mitigation |
|------|-----------|
| Subprocess overhead — running `openspec list --json` + `bd stats` for 15 projects every 60s | Stagger polls (2-3 projects per tick), skip projects without openspec/ dir |
| Stale `projects.json` — new project not in registry | Watcher only covers registered projects; add project to registry to enable |
| TTS spam from many simultaneous changes | Batch notifications — coalesce changes within a 5s window into a single message |
