# Polish & UX — Phase Context

> Bootstrapped: 2026-03-24
> Previous phase: Production Hardening (docs/plan/archive/2026-03-24-production-hardening/)

## Previous Phase Summary

Production Hardening delivered in 2 days (2026-03-23 → 2026-03-24): 11 specs across 7 waves,
100% planned delivery. All reliability issues fixed (port binding, memory, graceful shutdown,
auto-reconnect). M3 features complete (session detail, command palette, start session). Test
foundation established (61 tests, 8 suites). Config hot-reload and binary size documentation
shipped.

## Carry-Forward: Deferred Tasks

None — production-hardening had zero deferred tasks.

## Carry-Forward: Open Ideas (9)

These ideas were captured during previous sessions and represent validated needs:

| Slug | ID | Description |
|------|-----|-------------|
| global-layout-polish | nexus-3lr | Padding, rounded borders, Tabs widget, Paragraph::wrap, Rect::centered() |
| tui-textarea-input | nexus-9bb | Replace manual input with tui-textarea widget (cursor, selection, undo) |
| syntect-code-highlighting | nexus-0ky | Syntax highlighting for code blocks via syntect or tui-markdown |
| detail-block-widget | nexus-0jm | Reusable Block widget for session detail screen sections |
| health-gauge-sparkline | nexus-9mp | Gauge/sparkline widgets for health metrics visualization |
| stream-scrollbar-separation | nexus-4js | Separate scrollbar from stream content area |
| dashboard-table-liststate | nexus-vfw | Dashboard table using ratatui ListState for proper selection |
| ratatui-030-upgrade | nexus-7le | Upgrade ratatui to 0.30 for new APIs and improvements |
| deploy-monitoring | nexus-olr | Deploy monitoring and machine sync per project |

## Current Codebase State

```
Cargo Workspace (Rust 2024, tokio async)
├── crates/nexus-core/     Shared types, protobuf codegen, session model
├── crates/nexus-agent/    Per-machine daemon (tonic gRPC + axum HTTP)
├── crates/nexus-tui/      Terminal UI client (ratatui + tonic)
└── crates/nexus-register/ CC hook helper binary (start/stop/heartbeat)

LOC:      10,174 Rust
Tests:    61 (8 suites)
Binaries: nexus-agent 6.2M, nexus (TUI) 6.0M, nexus-register 3.9M
Deps:     tonic, ratatui (0.29), axum, sysinfo, notify, crossterm, reqwest, pulldown-cmark
Ports:    7400 (gRPC), 7401 (HTTP /health)
Config:   ~/.config/nexus/agents.toml (hot-reloaded)
Deploy:   systemd (Linux), launchd (Mac), pre-push git hook
```

## Runtime Observations

1. **Agent stability**: Post-hardening, agent runs reliably with consistent port binding and
   graceful shutdown. Auto-reconnect confirmed working.

2. **TUI rendering**: Markdown rendering uses custom pulldown-cmark pipeline. Code blocks lack
   syntax highlighting — language tags parsed but discarded. Several screens use manual arithmetic
   for layout instead of ratatui's built-in centering/padding.

3. **Input handling**: Stream input bar and scratchpad editor are hand-rolled string + cursor char.
   No selection, copy/paste, or undo support.

4. **Health display**: Raw text values — no visual gauges, sparklines, or color-coded thresholds.

5. **Dashboard**: Custom table rendering — could benefit from ratatui's ListState for proper
   keyboard-driven selection with scrolling.

## Themes for This Phase

Based on the 9 open ideas and runtime observations, this phase centers on:

1. **Visual polish**: Consistent padding, borders, widget styling across all screens
2. **Input quality**: Replace hand-rolled input with tui-textarea for proper editing
3. **Data visualization**: Syntax highlighting, health gauges, improved formatting
4. **Framework upgrade**: ratatui 0.30 for new APIs that simplify several ideas
5. **Operational visibility**: Deploy monitoring per project (the one non-cosmetic idea)

## Open Questions for This Phase

1. Should ratatui 0.30 upgrade be done first (unblocks new widget APIs)?
2. How much binary size impact is acceptable from syntect (~2MB)?
3. Should deploy-monitoring (nexus-olr) be in-scope or deferred as non-UX?
4. Are there screens/workflows that need redesign vs just visual polish?
5. Should we add mouse support while touching input handling?
