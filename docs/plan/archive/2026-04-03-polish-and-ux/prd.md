# Product Requirements Document — Nexus Polish & UX

> Generated: 2026-03-24
> Source artifacts: scope-lock.md, production-hardening COMPLETION.md
> Phase: polish-and-ux (post-hardening)

---

## 1. Vision & Problem Statement

**Vision:** Make Nexus TUI feel like a real product — btop/lazygit quality — by replacing every
hand-rolled rendering hack with proper ratatui widgets, adding visual data displays, and creating
smooth navigation between screens.

**Problem:** The TUI is functionally complete but visually prototype-grade. Hand-rolled rendering
hacks (manual Paragraph rows instead of Table, Unicode box-drawing instead of Block widgets, bare
usize selection instead of ListState) create visual jank, inconsistent styling, and poor navigation
feedback. Health metrics are raw text, code blocks lack highlighting, and the input bar has no
selection/undo support.

**One sentence:** "Replace prototype rendering with production-grade ratatui widgets everywhere."

*Source: scope-lock.md*

## 2. Current State

| Metric | Value |
|--------|-------|
| LOC | 10,174 Rust |
| Crates | 4 (nexus-core, nexus-agent, nexus-tui, nexus-register) |
| Tests | 61 (8 suites) |
| Screens | 6 (dashboard, detail, health, palette, projects, stream) |
| Binary sizes | nexus-agent: 6.2M, nexus (TUI): 6.0M, nexus-register: 3.9M |
| ratatui | 0.29 (upgrade target: 0.30) |
| Key deps | tonic, ratatui, axum, sysinfo, crossterm, pulldown-cmark |

*Source: codebase measurement, 2026-03-24*

## 3. Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Hand-rolled hacks | 0 remaining | Grep for manual Paragraph-as-table, manual Rect math, Unicode box-drawing |
| Screen consistency | All 5 screens styled uniformly | Visual review: padding, borders, colors match |
| Navigation indicator | Tab bar visible on all screens | Tabs widget rendered in every screen layout |
| Dashboard selection | Table + ListState + Scrollbar | Keyboard-driven selection with scroll |
| Health visualization | LineGauge + Sparkline | Visual meters replace text percentages |
| Health history | 1 hour ring buffer | Sparkline data persists across refreshes |
| Code highlighting | syntect coloring | Language-tagged code blocks render with colors |
| Input quality | tui-textarea | Cursor, selection, copy/paste, undo work |
| Deploy sync | Per-project status visible | Sync indicator on projects screen |
| Binary size | < 10M per binary | `ls -lh target/release/` |
| Test suite | 61+ tests pass | `cargo test` green |
| ratatui version | 0.30 | `Cargo.lock` |

## 4. Requirements

### R1: Framework Foundation (G1)

**Must-have:**

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| R1.1 | Upgrade ratatui 0.29 → 0.30 | `Cargo.toml` shows ratatui 0.30, `cargo build` passes |
| R1.2 | Upgrade crossterm 0.28 → 0.29 | KeyEvent/MouseEventKind API changes resolved |
| R1.3 | Replace terminal init with `ratatui::run()` | main.rs uses `ratatui::run()`, manual init/teardown removed |
| R1.4 | Replace overlay Rect math with `Rect::centered()` | All 4+ overlay sites use `Rect::centered()` |

**Beads:** nexus-7le

### R2: Dashboard & Navigation (G2)

**Must-have:**

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| R2.1 | Dashboard Table widget | Paragraph rows replaced with ratatui `Table` + header row |
| R2.2 | ListState for selection | `selected_index` replaced with `ListState`, proper scroll |
| R2.3 | Dashboard Scrollbar | `Scrollbar` widget on right edge, tracks selection position |
| R2.4 | Tabs widget for navigation | Visual tab bar showing all screens, highlights current |
| R2.5 | Global padding + borders | All panels use `Block::padding()`, `BorderType::Rounded` |
| R2.6 | Paragraph::wrap consistency | All text-heavy panels use `Paragraph::wrap(Wrap { trim: true })` |

**Beads:** nexus-vfw (R2.1-R2.3), nexus-3lr (R2.4-R2.6)

### R3: Monitoring & Visualization (G3)

**Must-have:**

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| R3.1 | LineGauge for CPU/RAM | Health screen shows visual meter bars with color thresholds |
| R3.2 | Sparkline history buffer | Ring buffer stores 1 hour of CPU/RAM samples in TUI memory |
| R3.3 | Sparkline rendering | Health screen shows sparkline charts of historical metrics |
| R3.4 | Health card borders | Block widgets with padding replace raw text layout |
| R3.5 | Deploy sync status | Projects screen shows last deploy commit + sync indicator per project |
| R3.6 | Deploy sync proto | Additive gRPC field for project deploy state (backward compatible) |
| R3.7 | Machine sync diff | Show how many commits behind each machine is per project |

**Beads:** nexus-9mp (R3.1-R3.4), nexus-olr (R3.5-R3.7)

### R4: Stream & Input (G4)

**Must-have:**

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| R4.1 | syntect code highlighting | Code blocks render with syntax colors based on language tag |
| R4.2 | Language tag extraction | pulldown-cmark `CodeBlockKind::Fenced(lang)` parsed and used |
| R4.3 | tui-textarea input bar | Stream input bar replaced with `tui-textarea` widget |
| R4.4 | tui-textarea scratchpad | Projects scratchpad editor replaced with `tui-textarea` |
| R4.5 | Stream Scrollbar | `Scrollbar` widget on stream view with position tracking |
| R4.6 | Message separators | Visual breaks between assistant/user/tool message groups |
| R4.7 | Detail Block widget | Detail screen cards use ratatui `Block` instead of Unicode borders |

**Beads:** nexus-0ky (R4.1-R4.2), nexus-9bb (R4.3-R4.4), nexus-4js (R4.5-R4.6), nexus-0jm (R4.7)

## 5. Non-Goals

| Item | Reason |
|------|--------|
| iMessage integration | Separate feature surface |
| Web dashboard | Future surface |
| Mouse support | Keyboard-first tool |
| Theme system | Single color scheme sufficient |
| Plugin system | Over-engineering |
| Split pane streams | Feature expansion |

## 6. Technical Constraints

| Constraint | Detail |
|------------|--------|
| ratatui 0.30 first | All specs must build on 0.30 — enforce wave ordering |
| Backward compat | gRPC proto changes additive only (Nova consumer) |
| Binary budget | < 10M per binary (syntect adds ~2MB, acceptable) |
| Health history | In-memory ring buffer only, no persistence |
| Test maintenance | 61 existing tests must pass; add snapshot tests for new widgets |
| Borrow plumbing | tui-textarea owns mutable state; render functions currently take `&App` |

## 7. Dependencies

| Spec | Depends On | Reason |
|------|-----------|--------|
| All G2/G3/G4 specs | ratatui-030-upgrade (G1) | New widget APIs required |
| health-gauge-sparkline | None beyond G1 | Self-contained TUI change + ring buffer |
| deploy-monitoring | None beyond G1 | Proto + agent + TUI (additive) |
| tui-textarea-input | None beyond G1 | Borrow plumbing change is internal |
| syntect-code-highlighting | None beyond G1 | New dep, render-layer change |

## 8. Milestones

| Milestone | Specs | Gate |
|-----------|-------|------|
| M1: Foundation | ratatui-030-upgrade | `cargo build` + `cargo test` pass on 0.30 |
| M2: Navigation | dashboard-table-liststate, global-layout-polish | All screens consistent, Tabs visible |
| M3: Visualization | health-gauge-sparkline, deploy-monitoring | Gauges + sparklines render, deploy status visible |
| M4: Refinement | syntect-code-highlighting, tui-textarea-input, stream-scrollbar-separation, detail-block-widget | All rendering hacks eliminated |
