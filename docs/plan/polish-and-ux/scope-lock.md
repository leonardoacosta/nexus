# Scope Lock — Polish & UX

> Locked: 2026-03-24
> Previous phase: Production Hardening (docs/plan/archive/2026-03-24-production-hardening/)
> Owner: leonardoacosta

## Vision

Make Nexus TUI feel like a real product — btop/lazygit quality — by replacing every hand-rolled
rendering hack with proper ratatui widgets, adding visual data displays, and creating smooth
navigation between screens.

**One sentence:** "Replace prototype rendering with production-grade ratatui widgets everywhere."

## Goals

### G1: Framework Foundation

Upgrade ratatui 0.29 → 0.30 as the prerequisite for all other work:

| Item | Impact |
|------|--------|
| `ratatui::run()` | Eliminates ~50 LOC of manual terminal init/teardown |
| `Rect::centered()` | Replaces 4+ manual overlay calculations |
| crossterm 0.28 → 0.29 | API compat (KeyEvent, MouseEventKind) |
| Border merging | Cleaner panel adjacency rendering |

### G2: Dashboard & Navigation (Primary Pain Points)

The most-used screens and the screen-switching experience:

| Item | Description |
|------|-------------|
| Dashboard table | Replace manual Paragraph rows with Table widget + ListState + Scrollbar |
| Tabs widget | Visual tab bar for screen navigation, replace invisible Tab/BackTab |
| Global layout polish | Consistent padding, rounded borders, Paragraph::wrap across all screens |
| Screen transitions | Eliminate visual jank, layout shifts, unclear current-screen indicators |

### G3: Monitoring & Data Visualization

Health screen is raw text — needs visual meters and history:

| Item | Description |
|------|-------------|
| LineGauge for CPU/RAM | Replace text percentages with visual meter bars |
| Sparkline history | Ring buffer for last hour of metrics, rendered as sparklines |
| Rounded card borders | Block widgets with proper padding on health cards |
| Deploy monitoring | Per-project deploy status, machine sync indicators, fast-forward |

### G4: Stream & Input Refinement

Stream view works but has rendering gaps:

| Item | Description |
|------|-------------|
| Syntax highlighting | syntect for code blocks (language tag from pulldown-cmark) |
| tui-textarea | Replace hand-rolled input bar + scratchpad with proper widget |
| Scrollbar | Position indicator on stream view |
| Message separation | Better visual breaks between message groups |
| Detail Block widget | Replace hand-drawn Unicode borders with ratatui Block on detail screen |

## Priority Order

1. **G1: Framework Foundation** — ratatui 0.30 upgrade (prerequisite, unblocks everything)
2. **G2: Dashboard & Navigation** — daily-use pain points, highest impact
3. **G3: Monitoring & Visualization** — transforms health screen from text dump to dashboard
4. **G4: Stream & Input** — important but stream view already "works" per user feedback

## Non-Goals (Out of Scope)

- **iMessage integration** — separate feature surface, not UX polish
- **Web dashboard** — future surface
- **Mouse support** — not requested, keyboard-first tool
- **Theme system** — single color scheme is fine for personal use
- **Plugin system** — over-engineering for current scale
- **Split pane streams** — feature expansion, not polish

## Hard Constraints

| Constraint | Detail |
|------------|--------|
| Backward compat | gRPC proto changes must be additive (Nova is a live consumer) |
| Binary size | +2MB for syntect is acceptable. Total budget: <10M per binary |
| ratatui 0.30 first | All other specs build on 0.30 APIs — enforce ordering |
| Health history | Ring buffer in TUI memory (1 hour). No persistence/DB needed |
| Deploy monitoring | Touches proto + agent + TUI. Must be additive to existing API |
| Tests | Maintain existing test suite (61 tests). Add snapshot tests for new widgets |

## Quality Bar

**"Feels like a real product"** — comparable to btop or lazygit:

- No hand-rolled rendering hacks remaining
- Consistent padding, borders, and color usage across all 5 screens
- Visual data displays (gauges, sparklines) instead of raw text
- Smooth navigation with clear current-screen indicator
- Syntax-highlighted code blocks
- Proper text input with cursor, selection, undo

## Beads Ideas Disposition

All 9 carry-forward ideas are **in scope**:

| ID | Slug | Goal |
|----|------|------|
| nexus-7le | ratatui-030-upgrade | G1 |
| nexus-vfw | dashboard-table-liststate | G2 |
| nexus-3lr | global-layout-polish | G2 |
| nexus-9mp | health-gauge-sparkline | G3 |
| nexus-olr | deploy-monitoring | G3 |
| nexus-0ky | syntect-code-highlighting | G4 |
| nexus-9bb | tui-textarea-input | G4 |
| nexus-4js | stream-scrollbar-separation | G4 |
| nexus-0jm | detail-block-widget | G4 |

## Timeline

No external deadline. Internal quality bar: "open Nexus and feel like using a polished tool."

## Success Criteria

- All 5 screens use consistent Block + padding + rounded borders
- Tab bar shows current screen, smooth transitions with no jank
- Dashboard uses Table + ListState + Scrollbar
- Health screen shows LineGauge + Sparkline (1h history ring buffer)
- Code blocks render with syntax highlighting via syntect
- Input bar uses tui-textarea (cursor, selection, undo)
- Stream view has Scrollbar + message separators
- Detail screen uses Block widgets (no hand-drawn Unicode)
- Deploy status visible per project with sync indicator
- Binary size < 10M per binary
- All existing tests pass + new snapshot tests for changed screens

## Assumptions Corrected

- **"Stream view is the primary pain"** → Dashboard + navigation + monitoring are the actual pain points. Stream view works acceptably.
- **"Deploy monitoring is out of scope"** → User considers it bundleable with polish. Include it but keep proto changes additive.
- **"ratatui 0.30 can wait"** → Make it Wave 1. Multiple ideas depend on 0.30 APIs.
- **"Binary size matters"** → Personal tool, 2MB for syntect is acceptable. Budget is <10M per binary.
- **"Last 5 min of health data is enough"** → User wants 1 hour of history for post-incident review.
