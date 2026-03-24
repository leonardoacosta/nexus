# Icon Style Guide

## Style

- **Type:** Unicode/box-drawing (TUI-native) + line icons for documentation
- **Corner radius:** Sharp (consistent with `┌─┐` box-drawing)
- **Stroke weight:** 1.5px (line icons in docs/web)
- **Size grid:** Single character width in TUI; 16/20/24/32px for web/docs

## TUI Icon Set (Unicode)

Terminal UIs don't use icon fonts — they use Unicode characters. These are the canonical
status and navigation symbols for Nexus.

| Symbol | Meaning | Usage |
|--------|---------|-------|
| `●` | Active | Session/agent actively executing |
| `○` | Idle | Awaiting input, heartbeat < 300s |
| `◌` | Stale | No heartbeat > 300s |
| `✖` | Error | Process dead, connection refused |
| `▸` | Selected | Current row/item indicator |
| `│` | Tree | Hierarchy connector |
| `├` | Branch | Sub-item connector |
| `└` | Last | Final sub-item |
| `⣿⣸⣰⠸⠰⠠⠀` | Sparkline | Activity over time (braille) |
| `↑` | Refresh | Last refresh timestamp |
| `→` | Navigate | Drill-down / attach |
| `⌂` | Home | Dashboard screen |
| `♥` | Health | Health screen |

## Personality Fit

These icons are deliberately **plain and functional**. Nexus's brand personality is
"direct, precise, technical" — icons should communicate state, not decorate. A `●` dot
says "active" faster than any SVG icon.

The braille sparklines (`⣿⣸⣰⠸`) are the signature visual element — they compress
time-series data into a few characters, which is exactly what Nexus does with sessions.

## Color Rules for Icons

Icons inherit their parent's semantic color:

| Context | Color | Example |
|---------|-------|---------|
| Active state | `#00D26A` | `●` green dot |
| Idle state | `#FFB700` | `○` amber dot |
| Error state | `#FF3B3B` | `✖` red cross |
| Structural | `#666666` | `│├└` dim connectors |
| Selected | `#00D26A` | `▸` green arrow |
| Neutral | `#C0C0C0` | `→ ↑` navigation |

## Web/Documentation Icons

For README, docs, and any future web surface, use line-style icons:

- **Source:** Lucide icons (MIT, consistent with ratatui ecosystem)
- **Weight:** 1.5px stroke
- **Size:** 20px default, 16px inline
- **Color:** Monochrome, inheriting text color

Relevant icons:
- `monitor` — machine/agent
- `terminal` — session
- `activity` — sparkline/health
- `link` — connection/attach
- `server` — agent daemon
- `layers` — projects
- `radio` — broadcast/WebSocket
