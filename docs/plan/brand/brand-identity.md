# Brand Identity: Nexus

## Name & Tagline

- **Product name:** Nexus
- **Tagline:** "Every agent, every machine, one view."
- **Elevator pitch:** Terminal dashboard that aggregates Claude Code sessions across your entire
  network and lets you attach to any of them.

## Voice & Tone

- **Personality:** Direct, precise, technical, understated, fast
- **Tone register:** Technical-casual — like a senior engineer's terminal output
- **Writing style:** Terse. Fragments over sentences. Data over description. Status codes over
  prose. No emoji in output. Abbreviations welcome (sess, proj, cfg).
- **Anti-patterns:** Never chatty, never cute, never uses "please" or "oops" or "whoops".
  Never marketing-speak. Never verbose where a number suffices.

### Voice Examples

```
# Good
3 agents · 12 sessions · 2 stale
homelab: 8 sess (3 active, 4 idle, 1 stale)
attach oo#1 → ssh nyaptor@homelab -t 'tmux a -t oo-main'

# Bad
"You have 3 agents connected with 12 total sessions! 🎉"
"Oops, looks like the homelab agent isn't responding. Try again later!"
"Successfully attached to session #1 in the oo project."
```

## Color Palette

Cyber green on dark. Inspired by btop's density with lazygit's clarity.

| Role | Hex | ANSI | Usage |
|------|-----|------|-------|
| **Primary (green)** | `#00D26A` | Green | Active status, focused borders, primary text |
| **Primary bright** | `#39FF14` | Bright Green | Sparklines, braille activity, accents |
| **Primary dim** | `#0A4A2A` | — | Selected row background, subtle highlights |
| **Secondary (cyan)** | `#00CED1` | Cyan | Links, secondary info, agent names |
| **Warning (amber)** | `#FFB700` | Yellow | Idle status, warnings, stale threshold |
| **Error (red)** | `#FF3B3B` | Red | Error status, disconnected, failed |
| **Success** | `#00D26A` | Green | Same as primary — active = success |
| **Neutral text** | `#C0C0C0` | White | Body text, labels, table content |
| **Neutral dim** | `#666666` | Bright Black | Borders, separators, inactive elements |
| **Background** | `#0D0D0D` | — | Terminal background (near-black) |
| **Surface** | `#1A1A1A` | — | Panel backgrounds, cards |
| **Surface highlight** | `#2A2A2A` | — | Hover/selected row, command palette |

### Contrast Ratios (against #0D0D0D background)

| Color | Ratio | WCAG |
|-------|-------|------|
| #00D26A (primary) | 8.2:1 | AAA |
| #39FF14 (bright) | 11.4:1 | AAA |
| #C0C0C0 (text) | 10.1:1 | AAA |
| #666666 (dim) | 4.0:1 | AA (large text) |
| #FFB700 (warning) | 9.6:1 | AAA |
| #FF3B3B (error) | 5.3:1 | AA |

## Typography System

Terminal-native. No font choice — the user's terminal font applies.

| Level | Style | Usage |
|-------|-------|-------|
| **Title** | UPPERCASE, bold, primary green | Screen headers: `SESSION DASHBOARD` |
| **Section** | Title case, dim green | Panel headers: `Machine Health` |
| **Label** | lowercase, neutral dim | Field labels: `project:` `branch:` |
| **Value** | Regular, neutral text | Data values: `oo` `main` `3m ago` |
| **Status** | Bold, status color | `●` `○` `◌` with semantic color |
| **Sparkline** | Braille, bright green | `⠀⠠⠰⠸⣰⣸⣿` activity over time |
| **Mono** | Regular weight | All text is monospace (terminal) |

### Typography Scale (Character-Based)

| Element | Width | Example |
|---------|-------|---------|
| Screen title | Full width, centered | `═══ SESSION DASHBOARD ═══` |
| Panel header | Panel width | `┌─ Health ─────────────┐` |
| Table header | Column-aligned | `PROJECT  SESSIONS  STATUS` |
| Key-value | Label: value | `branch: main` |
| Status line | Bottom bar | `3 agents · 12 sessions · ↑5m` |

## Design Principles

1. **Density over decoration** — Every pixel earns its space. If it's not data, it's noise.
2. **Green means go** — The primary color signals activity. Absence of green signals problems.
3. **Keyboard-first** — Visual affordances for keyboard navigation (selected row, focus ring),
   not mouse targets.
4. **Instant legibility** — A glance at the dashboard should tell you: how many sessions, which
   are active, any problems. No drill-down required for the summary.
5. **Consistent status language** — Green/dot = active, amber/dot = idle, red/dot = error.
   Same everywhere, no exceptions.

## Box Drawing Convention

| Element | Characters | Example |
|---------|-----------|---------|
| Panel border | `┌ ─ ┐ │ └ ┘` | `┌─ Sessions ──────┐` |
| Panel join | `├ ┤ ┬ ┴ ┼` | `├──────────────────┤` |
| Separator | `─` repeated | `────────────────────` |
| Selected row | Inverted bg (#0A4A2A) | Full row highlight |
| Active panel | Primary green border | `┌─` in #00D26A |
| Inactive panel | Dim border | `┌─` in #666666 |

## Status Indicators

| Status | Dot | Sparkline | Color | Meaning |
|--------|-----|-----------|-------|---------|
| Active | `●` | `⣿⣸⣰⠸` (high) | #00D26A | Agent executing, heartbeat < 60s |
| Idle | `○` | `⠠⠰⠀⠀` (low) | #FFB700 | Waiting for input, heartbeat < 300s |
| Stale | `◌` | `⠀⠀⠀⠀` (flat) | #666666 | Heartbeat > 300s, no activity |
| Error | `✖` | `⠀` (none) | #FF3B3B | Process dead or disconnected |
