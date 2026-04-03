# Roadmap — Polish & UX

> Generated: 2026-03-24
> Source: scope-lock.md, prd.md
> Phase: polish-and-ux

## Wave Structure

4 milestones, 5 waves, 9 specs. Ordered by dependency (G1 first) then impact (G2 before G3/G4).

### Wave 1: Framework Foundation (G1) — prerequisite

All subsequent specs build on ratatui 0.30 APIs.

| Spec | Beads | Description | Files |
|------|-------|-------------|-------|
| `ratatui-030-upgrade` | nexus-7le | 0.29→0.30, crossterm 0.29, `ratatui::run()`, `Rect::centered()` | Cargo.toml, main.rs, overlay sites |

**Gate:** `cargo build` + `cargo test` pass on ratatui 0.30.

### Wave 2: Dashboard & Navigation (G2) — primary pain points

Two specs, parallelizable — different files touched.

| Spec | Beads | Description | Files |
|------|-------|-------------|-------|
| `dashboard-table-liststate` | nexus-vfw | Table + ListState + Scrollbar for dashboard | dashboard.rs, main.rs, app.rs |
| `global-layout-polish` | nexus-3lr | Tabs widget, padding, rounded borders, Paragraph::wrap | all screens, markdown.rs, palette.rs |

**Gate:** All 5 screens consistent styling, Tab bar visible, dashboard selection works.

### Wave 3: Monitoring & Visualization (G3) — health + deploy

Two specs, parallelizable — health is TUI-only, deploy touches proto+agent+TUI.

| Spec | Beads | Description | Files |
|------|-------|-------------|-------|
| `health-gauge-sparkline` | nexus-9mp | LineGauge, Sparkline, 1h ring buffer, card borders | health.rs, app.rs, core/health.rs |
| `deploy-monitoring` | nexus-olr | Proto field, agent tracking, TUI sync indicator | proto, agent, projects.rs |

**Gate:** Health gauges + sparklines render. Deploy sync visible per project.

### Wave 4: Stream & Input (G4) — rendering refinement

Four specs. `syntect-code-highlighting` and `tui-textarea-input` are independent (different files).
`stream-scrollbar-separation` touches stream.rs (shared with textarea changes).
`detail-block-widget` is independent.

| Spec | Beads | Description | Files |
|------|-------|-------------|-------|
| `syntect-code-highlighting` | nexus-0ky | syntect dep, language tag extraction, Style→Color mapping | markdown.rs, Cargo.toml |
| `tui-textarea-input` | nexus-9bb | tui-textarea for input bar + scratchpad, borrow plumbing | stream.rs, projects.rs, app.rs, Cargo.toml |
| `stream-scrollbar-separation` | nexus-4js | Scrollbar + message separators + overlay Clear fix | stream.rs, palette.rs |
| `detail-block-widget` | nexus-0jm | Block widget replacing Unicode borders on detail cards | detail.rs |

**Gate:** Code blocks highlighted. Input has cursor/selection/undo. Scrollbar visible. Detail uses Block.

### Wave 5: Verification

No new specs — quality gate only.

- All 61+ existing tests pass
- New snapshot tests for changed screens
- Binary size < 10M per binary
- Visual review: no hand-rolled rendering hacks remain

## Summary

| Wave | Specs | Parallel? | Key Gate |
|------|-------|-----------|----------|
| 1 | 1 | — | `cargo build` + `cargo test` on 0.30 |
| 2 | 2 | Yes | Consistent styling, Tabs, Table+ListState |
| 3 | 2 | Yes | Gauges, sparklines, deploy sync |
| 4 | 4 | Partial (syntect+detail independent, textarea+scrollbar share stream.rs) | All hacks eliminated |
| 5 | 0 | — | Full verification pass |

**Total:** 9 specs across 4 implementation waves + 1 verification wave.

## Spec-to-Beads Mapping

| Spec Name | Beads ID | Priority |
|-----------|----------|----------|
| ratatui-030-upgrade | nexus-7le | Wave 1 (prerequisite) |
| dashboard-table-liststate | nexus-vfw | Wave 2 |
| global-layout-polish | nexus-3lr | Wave 2 |
| health-gauge-sparkline | nexus-9mp | Wave 3 |
| deploy-monitoring | nexus-olr | Wave 3 |
| syntect-code-highlighting | nexus-0ky | Wave 4 |
| tui-textarea-input | nexus-9bb | Wave 4 |
| stream-scrollbar-separation | nexus-4js | Wave 4 |
| detail-block-widget | nexus-0jm | Wave 4 |
